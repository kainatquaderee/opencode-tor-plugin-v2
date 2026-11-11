/**
 * opencode-tor-plugin-v2
 *
 * An OpenCode V2 plugin that routes outbound HTTP(S) traffic through Tor.
 *
 * The original `opencode-tor-plugin` (by vibecodingagency) is a V1 plugin and
 * cannot load in OpenCode V2 — V2 replaced the plugin API and a V1 default
 * export fails with: "Plugin must export a default definition with an id and an
 * effect or setup function."
 *
 * This is a full V2 port with one important correction. In V2, model-provider
 * HTTP does NOT go through `globalThis.fetch` (the transport is owned by the
 * runtime), and the `http.request`/`http.response` hooks only expose headers and
 * bodies, not the socket. Patching `fetch` therefore does nothing for provider
 * traffic. Routing works on two layers instead:
 *
 *   1. Provider traffic  -> the process HTTP proxy env vars (HTTP_PROXY,
 *      HTTPS_PROXY, ALL_PROXY) are set at setup. The runtime honours them, and
 *      Privoxy (default http://127.0.0.1:8118) forwards to Tor's SOCKS port.
 *   2. Other fetches     -> everything using `globalThis.fetch` is routed
 *      through the SOCKS5 proxy directly with netbun.
 *
 * Commands (send as a chat message): `@tor on|off|status|test|verify|proxy <url>`
 *
 * @license MIT
 */
import { Plugin } from "@opencode/plugin"
import { fetch as socksFetch } from "netbun"
import { connect } from "node:net"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const DEFAULT_PROXY = "socks5h://127.0.0.1:9050"
const DEFAULT_HTTP_PROXY = "http://127.0.0.1:8118"
const IP_ECHO_URL = "https://icanhazip.com"
const NO_PROXY_VALUE = "localhost,127.0.0.1,::1"

// Diagnostics: set OPENCODE_TOR_TRACE=1 to log every fetch the plugin sees.
const TRACE = process.env.OPENCODE_TOR_TRACE === "1"
const TRACE_FILE = process.env.OPENCODE_TOR_TRACE_FILE ?? join(tmpdir(), "opencode-tor-trace.log")
function trace(line: string) {
  if (!TRACE) return
  try {
    appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

type Settings = { enabled: boolean; proxy: string; httpProxy: string }
type FetchLike = typeof globalThis.fetch

function parseProxyUrl(proxy: string): { host: string; port: number } | null {
  try {
    const url = new URL(proxy)
    if (!["socks5:", "socks5h:", "http:", "https:"].includes(url.protocol)) return null
    const port = Number(url.port || (url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : 0))
    if (!url.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) return null
    return { host: url.hostname, port }
  } catch {
    return null
  }
}

function isProxyReachable(proxy: string, timeoutMs = 3000): Promise<boolean> {
  const parsed = parseProxyUrl(proxy)
  if (!parsed) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    let socket: ReturnType<typeof connect>
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {}
      resolve(ok)
    }
    socket = connect({ host: parsed.host, port: parsed.port })
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })
}

function parseIpv4(address: string): number[] | null {
  const m = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const parts = m.slice(1).map((p) => Number(p))
  if (parts.some((n) => n > 255)) return null
  return parts
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  let host = hostname.toLowerCase()
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1)
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") return true
  const v4 = parseIpv4(host)
  if (v4) {
    const [a, b] = v4
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    return false
  }
  if (host.includes(":")) {
    if (host.startsWith("fc") || host.startsWith("fd")) return true
    if (host.startsWith("fe80:")) return true
  }
  return false
}

function shouldRouteThroughProxy(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  return !isPrivateOrLocalHostname(url.hostname)
}

function extractUrl(input: unknown): URL | null {
  try {
    if (input instanceof URL) return input
    if (typeof input === "string") return new URL(input)
    if (typeof Request !== "undefined" && input instanceof Request) return new URL(input.url)
    return null
  } catch {
    return null
  }
}

// netbun expects socks5:// and can resolve DNS remotely (socks5h semantics)
function normalizeFetchProxy(proxy: string) {
  return { url: proxy.replace(/^socks5h:\/\//, "socks5://"), resolveDnsLocally: false }
}

interface TorRouter {
  fetch: FetchLike
  originalFetch: FetchLike
  setProxy: (proxy: string) => void
  restore: () => void
}

function createTorRouter(initial: Settings): TorRouter {
  const originalFetch = globalThis.fetch
  let proxy = initial.proxy
  let enabled = initial.enabled
  let reachable: boolean | undefined
  let warned = false

  const routed: FetchLike = (async (input: any, init?: any) => {
    const url = extractUrl(input)
    trace(`fetch url=${url?.href ?? String(input)} routable=${url ? shouldRouteThroughProxy(url) : false}`)
    if (!enabled || url === null || !shouldRouteThroughProxy(url)) {
      return originalFetch(input, init)
    }
    if (reachable === undefined) reachable = await isProxyReachable(proxy)
    if (!reachable) {
      if (!warned) {
        console.warn(`[tor] proxy ${proxy} unreachable — routing directly`)
        warned = true
      }
      return originalFetch(input, init)
    }
    return socksFetch(input, { ...(init ?? {}), proxy: normalizeFetchProxy(proxy) })
  }) as FetchLike

  return {
    fetch: routed,
    originalFetch,
    setProxy(next: string) {
      if (next !== proxy) {
        reachable = undefined
        warned = false
      }
      proxy = next
    },
    restore() {
      globalThis.fetch = originalFetch
    },
  }
}

function applyProxyEnv(settings: Settings) {
  if (settings.enabled) {
    process.env.HTTP_PROXY = settings.httpProxy
    process.env.HTTPS_PROXY = settings.httpProxy
    process.env.ALL_PROXY = settings.httpProxy
    process.env.NO_PROXY = NO_PROXY_VALUE
    trace(`env proxy -> ${settings.httpProxy}`)
  } else {
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    delete process.env.ALL_PROXY
    delete process.env.NO_PROXY
    trace("env proxy cleared")
  }
}

async function probeIp(fetchImpl: FetchLike): Promise<string> {
  try {
    const res = await fetchImpl(IP_ECHO_URL, { headers: { "User-Agent": "opencode-tor-plugin-v2" } })
    const text = (await res.text()).trim()
    return text || "(empty response)"
  } catch (err) {
    return `(error: ${err instanceof Error ? err.message : String(err)})`
  }
}

export default Plugin.define({
  id: "opencode-tor-plugin-v2",
  async setup(ctx) {
    const stored = (await ctx.storage.get("settings")) as Partial<Settings> | undefined
    let settings: Settings = {
      enabled: stored?.enabled ?? true,
      proxy: stored?.proxy ?? DEFAULT_PROXY,
      httpProxy: stored?.httpProxy ?? DEFAULT_HTTP_PROXY,
    }

    const router = createTorRouter(settings)
    globalThis.fetch = router.fetch
    applyProxyEnv(settings)
    trace(`setup enabled=${settings.enabled} socks=${settings.proxy} http=${settings.httpProxy}`)

    const persist = async () => {
      await ctx.storage.set("settings", settings)
    }

    const reply = (sessionID: string, text: string) => {
      console.log(text)
      try {
        void ctx.session.synthetic({ sessionID, text })
      } catch {}
    }

    const run = async (sessionID: string, sub: string | undefined, arg: string | undefined) => {
      switch (sub) {
        case undefined:
        case "status": {
          const [socksOk, httpOk] = await Promise.all([
            isProxyReachable(settings.proxy),
            isProxyReachable(settings.httpProxy),
          ])
          reply(
            sessionID,
            `[tor] ${settings.enabled ? "ENABLED" : "DISABLED"}\n` +
              `[tor] provider HTTP proxy: ${settings.httpProxy} (${httpOk ? "reachable" : "UNREACHABLE"})\n` +
              `[tor] fetch SOCKS5 proxy: ${settings.proxy} (${socksOk ? "reachable" : "UNREACHABLE"})`,
          )
          return
        }
        case "on": {
          settings = { ...settings, enabled: true }
          router.setProxy(settings.proxy)
          applyProxyEnv(settings)
          await persist()
          reply(sessionID, `[tor] ENABLED — provider traffic via ${settings.httpProxy}, fetch via ${settings.proxy}`)
          return
        }
        case "off": {
          settings = { ...settings, enabled: false }
          applyProxyEnv(settings)
          await persist()
          reply(sessionID, "[tor] DISABLED — routing directly")
          return
        }
        case "proxy": {
          if (!arg) {
            reply(sessionID, `[tor] provider=${settings.httpProxy} fetch=${settings.proxy}`)
            return
          }
          if (arg.startsWith("http://") || arg.startsWith("https://")) {
            settings = { ...settings, httpProxy: arg }
          } else {
            settings = { ...settings, proxy: arg }
            router.setProxy(arg)
          }
          applyProxyEnv(settings)
          await persist()
          reply(sessionID, `[tor] proxy set — provider=${settings.httpProxy} fetch=${settings.proxy}`)
          return
        }
        case "test": {
          const [socksOk, httpOk] = await Promise.all([
            isProxyReachable(settings.proxy, 5000),
            isProxyReachable(settings.httpProxy, 5000),
          ])
          reply(
            sessionID,
            `[tor] provider proxy ${settings.httpProxy} ${httpOk ? "reachable" : "UNREACHABLE"}\n` +
              `[tor] fetch proxy ${settings.proxy} ${socksOk ? "reachable" : "UNREACHABLE"}`,
          )
          return
        }
        case "verify": {
          const [direct, proxied] = await Promise.all([
            probeIp(router.originalFetch),
            probeIp(router.fetch),
          ])
          const ok = direct !== proxied && !proxied.startsWith("(error")
          reply(
            sessionID,
            `[tor] direct IP:  ${direct}\n` +
              `[tor] proxied IP: ${proxied}\n` +
              `[tor] verify ${ok ? "OK — fetch is routed through Tor" : "FAILED — fetch is NOT confirmed to route through Tor"}\n` +
              `[tor] note: verify covers the fetch path; provider traffic uses the HTTP proxy env (403 from some providers over Tor is normal).`,
          )
          return
        }
        default:
          reply(sessionID, "[tor] usage: @tor [on|off|status|test|verify|proxy <url>]")
      }
    }

    await ctx.session.hook("prompt", async (event) => {
      const text = (event.prompt?.text ?? "").trim()
      trace(`prompt text=${JSON.stringify(text)}`)
      const m = text.match(/^@tor(?:\s+(\S+))?(?:\s+(\S+))?/)
      if (!m) {
        // Diagnostic: the terminal UI parses `@` as a mention and may rewrite
        // the text before this hook runs. Log only prompts that look like ours.
        if (/@tor\b/i.test(text)) console.log(`[tor] prompt not matched: ${JSON.stringify(text)}`)
        return
      }
      await run(event.sessionID, m[1], m[2])
    })

    // TUI-safe path. The terminal UI parses `@tor` as an @-mention, so the
    // literal text may never reach the prompt hook above. A registered command
    // is not subject to mention parsing: use `/tor <subcommand>`.
    try {
      await ctx.command.transform((editor) => {
        editor.add({
          name: "tor",
          description: "Control Tor routing: on | off | status | test | verify | proxy <url>",
          execute: async ({ sessionID, prompt }) => {
            const raw = (prompt?.text ?? "").trim()
              .replace(/^\/tor\b/i, "")
              .replace(/^@tor\b/i, "")
              .trim()
            const parts = raw.split(/\s+/).filter(Boolean)
            trace(`command text=${JSON.stringify(raw)}`)
            await run(sessionID, parts[0], parts[1])
          },
        })
      })
    } catch (err) {
      console.warn("[tor] failed to register /tor command", err)
    }

    return () => {
      router.restore()
      delete process.env.HTTP_PROXY
      delete process.env.HTTPS_PROXY
      delete process.env.ALL_PROXY
      delete process.env.NO_PROXY
    }
  },
})
