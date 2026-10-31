'use strict';
// Minimal RFC 6455 WebSocket server: text/binary, fragmentation, ping/pong, close.
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function encodeFrame(opcode, payload, fin = true) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0x00) | opcode;
  return Buffer.concat([header, payload]);
}

class Socket extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    this.alive = true;
    this.bytesOut = 0;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this._teardown());
    socket.on('close', () => this._teardown());
    socket.setNoDelay(true);
  }

  get readyState() { return this.closed ? 3 : 1; }

  send(data) {
    if (this.closed) return false;
    const isBuffer = Buffer.isBuffer(data);
    const payload = isBuffer ? data : Buffer.from(String(data), 'utf8');
    try {
      this.socket.write(encodeFrame(isBuffer ? 0x2 : 0x1, payload));
      this.bytesOut += payload.length;
      return true;
    } catch {
      this._teardown();
      return false;
    }
  }

  sendJSON(obj) { return this.send(JSON.stringify(obj)); }

  ping() {
    if (this.closed) return;
    try { this.socket.write(encodeFrame(0x9, Buffer.alloc(0))); } catch { this._teardown(); }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    try { this.socket.write(encodeFrame(0x8, payload)); } catch { /* ignore */ }
    this._teardown();
    try { this.socket.end(); } catch { /* ignore */ }
  }

  _teardown() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > 64n * 1024n * 1024n) { this.close(1009, 'too large'); return; }
        len = Number(big);
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + len) return;
      const maskKey = masked ? this.buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(this.buffer.subarray(offset + maskLen, offset + maskLen + len));
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      this.buffer = this.buffer.subarray(offset + maskLen + len);
      this._onFrame(fin, opcode, payload);
    }
  }

  _onFrame(fin, opcode, payload) {
    switch (opcode) {
      case 0x0: { // continuation
        if (!this.fragments.length) return;
        this.fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(this.fragments);
          const op = this.fragmentOpcode;
          this.fragments = [];
          this.fragmentOpcode = 0;
          this._dispatch(op, whole);
        }
        return;
      }
      case 0x1: case 0x2:
        if (!fin) { this.fragmentOpcode = opcode; this.fragments = [payload]; return; }
        this._dispatch(opcode, payload);
        return;
      case 0x8:
        this.close(1000, '');
        return;
      case 0x9:
        if (!this.closed) { try { this.socket.write(encodeFrame(0xa, payload)); } catch { this._teardown(); } }
        return;
      case 0xa:
        this.alive = true;
        return;
      default:
        return;
    }
  }

  _dispatch(opcode, payload) {
    if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
    else this.emit('binary', payload);
  }
}

function attach(httpServer, onConnection, path = '/ws', options = {}) {
  httpServer.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== path) { socket.destroy(); return; }
    if (options.authorize && !options.authorize(req)) {
      if (options.reject) options.reject(socket);
      else { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); }
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );
    const ws = new Socket(socket, req);
    ws.query = url.searchParams;
    onConnection(ws, req);
  });
}

module.exports = { attach, Socket };
