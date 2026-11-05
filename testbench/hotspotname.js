// A friendlier address on the laptop's hotspot: http://phonepad.local, with no port number.
//   name   a small mDNS responder. The hotspot gives phones no DNS server, so .local is the only name
//          a phone can look up there. Android 13+ does this by itself; older phones use the QR code.
//   port   80, on the hotspot's address only, so web servers the user runs elsewhere are unaffected.
//          IIS and others can already hold it; the address then simply keeps :8080.
// Both are extras: :8080 keeps working, and anything that can't start is reported, never fatal.
import dgram from 'node:dgram';
import net from 'node:net';

export const HOTSPOT_NAME = 'phonepad.local';

const MDNS_GROUP = '224.0.0.251', MDNS_PORT = 5353, TTL = 120;
const TYPE_A = 1, TYPE_ANY = 255, CLASS_IN = 1, QU_OR_FLUSH = 0x8000;

export const front = { http: false, mdns: false };   // what is actually up right now
let current = null, tcp = null, udp = null;

const encodeName = (name) => Buffer.concat([...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);

// Returns [name, offset after the name], following compression pointers. Throws on malformed input.
function readName(m, start) {
  const labels = [];
  let i = start, end = -1;
  for (let hops = 0; hops < 16; hops++) {
    const len = m[i];
    if (len === undefined) throw new Error('truncated');
    if (len === 0) return [labels.join('.').toLowerCase(), end < 0 ? i + 1 : end];
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = i + 2;
      i = ((len & 0x3f) << 8) | m[i + 1];
    } else {
      labels.push(m.toString('latin1', i + 1, i + 1 + len));
      i += len + 1;
    }
  }
  throw new Error('name loop');
}

// The first question in a query asking for our address, or null.
export function matchQuery(m) {
  if (m.length < 12 || (m[2] & 0x80)) return null;   // too short, or a response
  let at = 12;
  for (let q = m.readUInt16BE(4); q > 0; q--) {
    const [name, next] = readName(m, at);
    const type = m.readUInt16BE(next), cls = m.readUInt16BE(next + 2);
    if (name === HOTSPOT_NAME && (type === TYPE_A || type === TYPE_ANY) && (cls & ~QU_OR_FLUSH) === CLASS_IN) {
      return { id: m.readUInt16BE(0), unicast: !!(cls & QU_OR_FLUSH), type };
    }
    at = next + 4;
  }
  return null;
}

// `legacy`: the asker is a one-shot resolver, not a full mDNS stack, so it expects an ordinary DNS reply.
export function buildAnswer(ip, query, legacy) {
  const name = encodeName(HOTSPOT_NAME);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(legacy ? query.id : 0, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(legacy ? 1 : 0, 4);
  header.writeUInt16BE(1, 6);
  const question = Buffer.alloc(4);
  question.writeUInt16BE(query.type, 0);
  question.writeUInt16BE(CLASS_IN, 2);
  const record = Buffer.alloc(10);
  record.writeUInt16BE(TYPE_A, 0);
  record.writeUInt16BE(legacy ? CLASS_IN : CLASS_IN | QU_OR_FLUSH, 2);
  record.writeUInt32BE(legacy ? 10 : TTL, 4);
  record.writeUInt16BE(4, 8);
  return Buffer.concat([header, ...(legacy ? [name, question] : []), name, record, Buffer.from(ip.split('.').map(Number))]);
}

function startMdns(ip) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });   // Windows' own mDNS shares this port
  const subnet = ip.split('.').slice(0, 3).join('.') + '.';
  sock.on('error', (e) => { console.warn(`[name] mDNS: ${e.message}`); front.mdns = false; });
  sock.on('message', (m, from) => {
    if (!from.address.startsWith(subnet)) return;   // only ever answer on the hotspot
    let query;
    try { query = matchQuery(m); } catch { return; }
    if (!query) return;
    const legacy = from.port !== MDNS_PORT;
    const reply = buildAnswer(ip, query, legacy);
    if (legacy || query.unicast) sock.send(reply, from.port, from.address);
    else sock.send(reply, MDNS_PORT, MDNS_GROUP);
  });
  sock.bind(MDNS_PORT, () => {
    try {
      sock.addMembership(MDNS_GROUP, ip);
      sock.setMulticastInterface(ip);
      front.mdns = true;
    } catch (e) { console.warn(`[name] mDNS: ${e.message}`); }
  });
  return sock;
}

function startTcp(ip, onConnection) {
  const server = net.createServer({ noDelay: true }, onConnection);
  server.on('error', (e) => { console.warn(`[name] port 80: ${e.message}. The hotspot address keeps :8080.`); front.http = false; });
  server.listen(80, ip, () => { front.http = true; });
  return server;
}

// Call whenever networks change, with the hotspot's address or null when it is down.
export function syncHotspotName(ip, onConnection) {
  if (ip === current) return;
  current = ip;
  tcp?.close();
  try { udp?.close(); } catch {}
  tcp = udp = null;
  Object.assign(front, { http: false, mdns: false });
  if (!ip) return;
  tcp = startTcp(ip, onConnection);
  udp = startMdns(ip);
}
