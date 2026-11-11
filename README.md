# opencode-tor-plugin-v2

An [OpenCode](https://opencode.ai) **V2** plugin that routes outbound HTTP(S)
traffic through the [Tor](https://www.torproject.org/) network.

It is a full port of the V1 [`opencode-tor-plugin`](https://www.npmjs.com/package/opencode-tor-plugin)
to the OpenCode V2 plugin API — with one important correction to how routing is
applied (see [How it works](#how-it-works)).

> **Experimental.** Patching `globalThis.fetch` and setting process proxy env
> vars can interact with other plugins or future OpenCode releases. Use at your
> own risk.
>
> **Disclaimer.** This is an independent, community plugin. It is **not**
> affiliated with, endorsed by, or maintained by the Tor Project, OpenCode, or
> their respective teams. Trademarks belong to their owners. Tor is a tool for
> privacy and circumvention; make sure your use complies with the laws that
> apply to you.

## Why a V2 port

OpenCode V2 intentionally changed the plugin API. A V1 plugin (an async factory
default export) fails to load with:

```
Plugin must export a default definition with an id and an effect or setup function.
```

A V2 plugin must export `Plugin.define({ id, setup })`. Beyond that, the V1
trick of patching `globalThis.fetch` **does not route model-provider traffic in
V2**: the provider transport is owned by the runtime and does not use the global
`fetch`, and the `http.request`/`http.response` hooks only expose headers and
bodies — not the socket. This plugin therefore routes on two layers.

## Features

- **Provider traffic through Tor** via the process HTTP proxy environment
  variables (honoured by the runtime).
- **`fetch` consumers through Tor** by patching `globalThis.fetch` and tunnelling
  over SOCKS5 with [`netbun`](https://www.npmjs.com/package/netbun).
- Default-on: routing starts as soon as the plugin loads.
- Reachability probe with automatic fallback to direct routing when the proxy is
  down.
- Local/private addresses (localhost, RFC 1918, link-local, ULA) bypass the
  proxy so OpenCode's own services and local model providers keep working.
- Chat commands: `@tor on|off|status|test|verify|proxy <url>`.

## Requirements

- OpenCode **v2** (the plugin runs under OpenCode's bundled Bun runtime).
- A Tor daemon with a SOCKS5 listener — default `127.0.0.1:9050`.
- An **HTTP** proxy that forwards to Tor for the provider path, because the
  runtime's proxy env vars do **not** support `socks5://` schemes (they raise
  `UnsupportedProxyProtocol`). Privoxy is the common choice and defaults to
  `127.0.0.1:8118`.

Minimal Privoxy configuration:

```conf
listen-address  127.0.0.1:8118
forward-socks5t / 127.0.0.1:9050 .
```

## Install

### From a local clone (recommended, fully tested)

```sh
git clone https://github.com/kainatquaderee/opencode-tor-plugin-v2.git \
  ~/.config/opencode/plugins/opencode-tor-plugin-v2
cd ~/.config/opencode/plugins/opencode-tor-plugin-v2
npm install        # installs netbun
```

Then reference the directory in your OpenCode config
(`~/.config/opencode/opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "~/.config/opencode/plugins/opencode-tor-plugin-v2"
  ]
}
```

OpenCode loads the plugin from `index.ts` directly (it runs on Bun). Config is
watched, so saving triggers a reload — no restart required.

### From npm

```jsonc
{
  "plugins": ["opencode-tor-plugin-v2"]
}
```

## Usage

In the TUI, use the command form:

```text
/tor status
/tor test
/tor verify
/tor on
/tor off
/tor proxy socks5h://127.0.0.1:9050
```

> The terminal UI reserves `@` for @-mentions, so `@tor …` can be rewritten
> before the plugin sees it. `/tor …` is parsed as a command and is reliable.
> The `@tor …` form still works in `opencode run` and clients that pass the
> literal text.

| Command | Description |
| --- | --- |
| `@tor status` | Show enabled/disabled and reachability of both proxies. |
| `@tor test` | TCP reachability check for both proxies. |
| `@tor verify` | Compare direct vs. proxied public IP for the `fetch` path. |
| `@tor on` / `@tor off` | Enable or disable routing. |
| `@tor proxy <url>` | Set the proxy. `http(s)://…` sets the provider proxy; `socks5(h)://…` sets the fetch proxy. |

State is persisted between sessions via OpenCode's plugin storage.

Every command replies in the session transcript as a synthetic message, so the
output is visible in the TUI. Delivery is awaited and retried; if the server
rejects both attempts, the reason is written to the server log instead of being
silently dropped.

Notes:

- `/tor …` runs the command only; it does not call the model. With the `@tor …`
  form the message is also delivered to the model (the V2 `prompt` hook cannot
  drop a prompt), and the reply is an additional synthetic message.
- `@tor verify` measures the `fetch` layer. The provider layer is verified
  separately — see [Verifying](#verifying).

## Configuration

Routing is configured with the commands above (persisted). Defaults:

| Layer | Default |
| --- | --- |
| Provider HTTP proxy (`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`) | `http://127.0.0.1:8118` |
| `fetch` SOCKS5 proxy | `socks5h://127.0.0.1:9050` |
| `NO_PROXY` | `localhost,127.0.0.1,::1` |

## How it works

V1 routed everything by replacing `globalThis.fetch`. In V2 that only covers
code that actually calls the global `fetch`; model-provider HTTP does not.

1. **Provider traffic.** At `setup`, the plugin sets `HTTP_PROXY`, `HTTPS_PROXY`,
   and `ALL_PROXY` to an HTTP proxy (Privoxy) that forwards to Tor's SOCKS port,
   plus `NO_PROXY` for local addresses. The runtime honours these variables, so
   provider requests leave through Tor. `@tor off` removes them.
2. **`globalThis.fetch`.** The plugin wraps the global `fetch`; for public
   HTTP(S) URLs it tunnels through the SOCKS5 proxy using `netbun`. Local and
   private URLs are passed through untouched.

Because the proxy env vars apply to the whole server process, routing is global
for that OpenCode instance, not per provider.

## Verifying

```sh
# Tor SOCKS5 is reachable and egresses from a different IP
curl -s --socks5-hostname 127.0.0.1:9050 https://icanhazip.com

# Privoxy -> Tor works
curl -s -x http://127.0.0.1:8118 https://icanhazip.com
```

Both should print an IP different from your direct (`curl -s https://icanhazip.com`)
address. In chat, `@tor verify` checks the `fetch` layer: it samples the direct
IP with proxy environment variables bypassed (`node:https`) and compares it with
the Tor-routed `fetch`, so the two samples are genuinely independent.

## Troubleshooting

- **`UnsupportedProxyProtocol …`** — you pointed a proxy env var at a `socks5://`
  URL. Use an HTTP proxy (Privoxy) for the provider path.
- **`HTTP 403` from a provider** — some providers block Tor exit nodes (Google's
  `generativelanguage` is a known example). Use `@tor off`, or a provider that
  tolerates Tor.
- **Local model provider breaks** — ensure its host is covered by `NO_PROXY`
  (add it with `@tor proxy` if needed).
- **Diagnostics** — set `OPENCODE_TOR_TRACE=1` (optionally
  `OPENCODE_TOR_TRACE_FILE=/path`) to log every `fetch` the plugin observes.

## Credits

- Ported from [`opencode-tor-plugin`](https://www.npmjs.com/package/opencode-tor-plugin) (MIT).
- SOCKS5 tunnelling for Bun by [`netbun`](https://www.npmjs.com/package/netbun).

## License

[MIT](./LICENSE)
