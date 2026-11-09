import net from 'node:net'

/** Addresses that reach this computer or a private network. 0.0.0.0/8 and :: also reach this machine on some systems. */
const LOCAL_ADDRESSES = new net.BlockList()
for (const [net4, prefix] of [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
  ['100.64.0.0', 10],
  ['0.0.0.0', 8]
] as const) {
  LOCAL_ADDRESSES.addSubnet(net4, prefix, 'ipv4')
}
LOCAL_ADDRESSES.addAddress('::', 'ipv6')
LOCAL_ADDRESSES.addAddress('::1', 'ipv6')
LOCAL_ADDRESSES.addSubnet('fc00::', 7, 'ipv6')
LOCAL_ADDRESSES.addSubnet('fe80::', 10, 'ipv6')

/**
 * Why the orchestrator may not fetch this URL, or null when it may. The URL parser has already turned decimal, hex
 * and short IPv4 forms into dotted quads. Limit: only the URL is seen here, so a DNS name that resolves to a
 * private address can't be caught. The SDK's WebFetch asks again for a redirect to another host, so a redirect is
 * checked as a new call.
 */
export function webFetchRefusal(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return 'WebFetch needs a full http or https URL.'
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return 'WebFetch needs a full http or https URL.'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `Only http and https pages can be fetched, not ${url.protocol}`
  }
  if (url.username !== '' || url.password !== '') {
    return 'This URL has a user name or password in it; credentials are never sent.'
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return `${host} is on this computer or the local network.`
  }
  const family = net.isIP(host)
  if (family !== 0 && LOCAL_ADDRESSES.check(host, family === 6 ? 'ipv6' : 'ipv4')) {
    return `${host} is a local or private network address.`
  }
  return null
}
