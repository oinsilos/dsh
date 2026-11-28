/**
 * Gateway port helper — the only surviving piece of the old channel-gateway
 * relay (A）及其局域网中继（C）已删除：自动路由池只活在本插件自己的转发
 * 端口上，另开一套网关只会让「外部到底该连哪个」变成选择题。
 *
 * What remains is the port fallback the *channel pack* needs before it mounts:
 * its gateway defaults to 8326 and walks up on EADDRINUSE, but Windows often
 * *reserves* the whole neighbourhood (EACCES), so every candidate fails and the
 * pack reads "on, not listening" forever. Settling the env var here is the fix.
 *
 * @module src/chan-relay.js
 */

import http from 'node:http'

/** Can this process bind the port at all? EACCES (reserved range) counts as no. */
function canBind(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const server = http.createServer()
    const settle = answer => {
      server.removeAllListeners()
      try { server.close() } catch { /* never opened */ }
      resolve(answer)
    }
    server.once('error', () => settle(false))
    server.once('listening', () => server.close(() => settle(true)))
    try {
      server.listen(port, host)
    } catch {
      settle(false)
    }
  })
}

/**
 * Move the gateway off a port this machine will not hand out.
 *
 * Only an environment default is chosen here: an explicit
 * `DSH_OPENAI_GATEWAY_PORT` is never overridden. Returns the port it picked,
 * or null when the default already binds.
 */
export async function pickGatewayPort({ env = process.env, desired = 8326, span = 512 } = {}) {
  if (String(env.DSH_OPENAI_GATEWAY_PORT ?? '').trim() !== '') return null
  if (await canBind(desired)) return null
  for (let offset = 1; offset <= span; offset += 1) {
    const port = desired + offset
    if (port > 65535) break
    if (await canBind(port)) {
      env.DSH_OPENAI_GATEWAY_PORT = String(port)
      return port
    }
  }
  return null
}
