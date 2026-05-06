import { dns } from "bun";

/** 检查 IPv6 地址是否为私有/保留范围 */
function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.replace(/^\[|\]$/g, "").toLowerCase();
  /** 回环 */
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || normalized === "::" || normalized === "0:0:0:0:0:0:0:0") return true;
  /** IPv4-mapped IPv6 (::ffff:x.x.x.x) */
  const mappedMatch = /(?:^|::ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mappedMatch) return isPrivateIp(mappedMatch[1]!);
  /** Unique Local Address (fc00::/7) */
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fc00") || normalized.startsWith("fd00")) return true;
  /** Link-Local (fe80::/10) */
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  /** Multicast (ff00::/8) */
  if (normalized.startsWith("ff")) return true;
  /** Documentation (2001:db8::/32) */
  if (normalized.startsWith("2001:db8")) return true;
  return false;
}

/** 检查 URL 是否指向内网/私有地址 */
export function isPrivateUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  const host = parsed.hostname.toLowerCase();

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4Match) {
    const octets = [Number(ipv4Match[1]), Number(ipv4Match[2]), Number(ipv4Match[3]), Number(ipv4Match[4])];
    const ip = (octets[0]! << 24 | octets[1]! << 16 | octets[2]! << 8 | octets[3]!) >>> 0;
    if ((ip >>> 24) === 10) return true;
    if ((ip >>> 20) === 0xAC1) return true;
    if ((ip >>> 16) === 0xC0A8) return true;
    if ((ip >>> 16) === 0xA9FE) return true;
    if ((ip >>> 24) === 127) return true;
    if ((ip >>> 24) === 0) return true;
    if ((ip >>> 22) === 0x191) return true;
    if ((ip >>> 28) === 0xE) return true;
  }

  if (host === "localhost") return true;
  /** IPv6 检查 */
  if (isPrivateIpv6(host)) return true;
  return false;
}

/** 检查解析后的 IP 地址是否为内网地址 */
export function isPrivateIp(ip: string): boolean {
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (ipv4Match) {
    const octets = [Number(ipv4Match[1]), Number(ipv4Match[2]), Number(ipv4Match[3]), Number(ipv4Match[4])];
    const num = (octets[0]! << 24 | octets[1]! << 16 | octets[2]! << 8 | octets[3]!) >>> 0;
    if ((num >>> 24) === 10) return true;
    if ((num >>> 20) === 0xAC1) return true;
    if ((num >>> 16) === 0xC0A8) return true;
    if ((num >>> 16) === 0xA9FE) return true;
    if ((num >>> 24) === 127) return true;
    if ((num >>> 24) === 0) return true;
    if ((num >>> 22) === 0x191) return true;
    if ((num >>> 28) === 0xE) return true;
  }
  /** IPv6 检查 */
  if (isPrivateIpv6(ip)) return true;
  return false;
}

/** DNS 解析验证：防止 DNS rebinding 攻击，返回 true 表示安全可访问 */
export async function isSafeWebhookUrl(url: string): Promise<boolean> {
  if (isPrivateUrl(url)) return false;
  try {
    const hostname = new URL(url).hostname;
    /** 优先 IPv4 解析 */
    const resolved4 = await dns.lookup(hostname, { family: 4 }).catch<null>(() => null);
    const first4 = resolved4?.[0];
    if (first4 && isPrivateIp(first4.address)) return false;
    /** 也检查 IPv6 解析 */
    const resolved6 = await dns.lookup(hostname, { family: 6 }).catch<null>(() => null);
    const first6 = resolved6?.[0];
    if (first6 && isPrivateIpv6(first6.address)) return false;
  } catch {
    /** DNS 解析失败时不阻止请求 */
  }
  return true;
}
