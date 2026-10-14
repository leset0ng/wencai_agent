import { env } from '#/server/env'

/** The configured browser origin is authoritative; a TLS proxy's internal HTTP URL is not. */
export function validRequestOrigin(request: Request, publicBaseURL = env.PUBLIC_BASE_URL): boolean {
  const supplied = request.headers.get('origin')
  if (supplied === null) return request.headers.get('sec-fetch-site') !== 'cross-site'
  try {
    const origin = new URL(supplied)
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
        origin.pathname !== '/' || origin.search || origin.hash) return false
    const configured = new URL(publicBaseURL)
    if (origin.origin === configured.origin) return true
    // Match the login layer's localhost/127.0.0.1 aliases, preserving protocol and port.
    if (['localhost', '127.0.0.1'].includes(configured.hostname) && ['localhost', '127.0.0.1'].includes(origin.hostname)) {
      return origin.protocol === configured.protocol && origin.port === configured.port
    }
  } catch {
    return false
  }
  // Host, Forwarded and X-Forwarded-* must not widen the allowed origin list.
  return false
}
