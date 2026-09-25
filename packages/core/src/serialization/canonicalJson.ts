import { sha256Bytes, sha256Hex } from "./sha256";
import {
  CANONICAL_JSON_LIMITS_V1,
  SERIALIZATION_LIMIT_EXCEEDED_ERROR,
} from "../spec/formatVersions";

export const CANONICALIZATION_VERSION = "jcs-rfc8785-v1" as const;
export const DIGEST_ALGORITHM_VERSION = "sha256-v1" as const;

export class CanonicalJsonError extends Error {
  override readonly name = "CanonicalJsonError";
  readonly code: string | undefined;
  constructor(message: string, options?: { code?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.code = options?.code;
  }
}

const utf8Encoder = new TextEncoder();

function utf8ByteLength(s: string): number {
  return utf8Encoder.encode(s).byteLength;
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= s.length) return true;
      const n = s.charCodeAt(i + 1);
      if (n < 0xdc00 || n > 0xdfff) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function compareByte(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function throwLimit(message: string): never {
  throw new CanonicalJsonError(message, { code: SERIALIZATION_LIMIT_EXCEEDED_ERROR });
}

export function encodeBase64UrlUnpadded(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) {
    throw new CanonicalJsonError("encodeBase64UrlUnpadded expects Uint8Array");
  }
  if (bytes.length === 0) return "";
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    const b2 = bytes[i + 2]!;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += alpha[(n >> 18) & 63]! + alpha[(n >> 12) & 63]! + alpha[(n >> 6) & 63]! + alpha[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const b0 = bytes[i]!;
    const n = b0 << 16;
    out += alpha[(n >> 18) & 63]! + alpha[(n >> 12) & 63]!;
  } else if (rem === 2) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    const n = (b0 << 16) | (b1 << 8);
    out += alpha[(n >> 18) & 63]! + alpha[(n >> 12) & 63]! + alpha[(n >> 6) & 63]!;
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_");
}

export function decodeBase64UrlUnpadded(s: string): Uint8Array {
  if (typeof s !== "string") {
    throw new CanonicalJsonError("decodeBase64UrlUnpadded expects string");
  }
  if (s.length === 0) return new Uint8Array(0);
  if (!/^[A-Za-z0-9_-]*$/.test(s)) {
    throw new CanonicalJsonError("invalid base64url characters");
  }
  if (s.length % 4 === 1) {
    throw new CanonicalJsonError("invalid base64url length");
  }
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  if (pad) b64 += "=".repeat(pad);
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Int8Array(256);
  lookup.fill(-1);
  for (let i = 0; i < alpha.length; i++) {
    lookup[alpha.charCodeAt(i)] = i;
  }
  let bytesLen = (b64.length * 3) / 4;
  if (b64.endsWith("==")) bytesLen -= 2;
  else if (b64.endsWith("=")) bytesLen -= 1;
  const bytes = new Uint8Array(bytesLen);
  let out = 0;
  for (let i = 0; i < b64.length; i += 4) {
    const ch0 = b64[i]!;
    const ch1 = b64[i + 1]!;
    const ch2 = b64[i + 2]!;
    const ch3 = b64[i + 3]!;
    const c0 = lookup[ch0.charCodeAt(0)]!;
    const c1 = lookup[ch1.charCodeAt(0)]!;
    const c2 = ch2 === "=" ? 0 : lookup[ch2.charCodeAt(0)]!;
    const c3 = ch3 === "=" ? 0 : lookup[ch3.charCodeAt(0)]!;
    if (c0 === -1 || c1 === -1 || (ch2 !== "=" && c2 === -1) || (ch3 !== "=" && c3 === -1)) {
      throw new CanonicalJsonError("invalid base64url encoding");
    }
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (out < bytesLen) bytes[out++] = (n >> 16) & 0xff;
    if (out < bytesLen) bytes[out++] = (n >> 8) & 0xff;
    if (out < bytesLen) bytes[out++] = n & 0xff;
  }
  return bytes;
}

export function isValidRfc3339Millis(s: string): boolean {
  if (typeof s !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)) return false;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString() === s;
}

export function assertRfc3339Millis(s: string): void {
  if (!isValidRfc3339Millis(s)) {
    throw new CanonicalJsonError(`invalid RFC3339 UTC milliseconds timestamp: ${JSON.stringify(s)}`);
  }
}

export function canonicalizeValue(value: unknown): unknown {
  let totalNodes = 0;
  const seen = new WeakSet<object>();

  const visit = (val: unknown, depth: number): unknown => {
    if (depth > CANONICAL_JSON_LIMITS_V1.maxDepth) {
      throwLimit(`canonical JSON depth ${depth} exceeds maxDepth ${CANONICAL_JSON_LIMITS_V1.maxDepth}`);
    }
    totalNodes++;
    if (totalNodes > CANONICAL_JSON_LIMITS_V1.maxTotalNodes) {
      throwLimit(`canonical JSON total nodes ${totalNodes} exceeds maxTotalNodes ${CANONICAL_JSON_LIMITS_V1.maxTotalNodes}`);
    }

    if (val === null) return null;
    if (typeof val === "boolean") return val;
    if (typeof val === "string") {
      if (hasLoneSurrogate(val)) {
        throw new CanonicalJsonError("string contains lone surrogate");
      }
      const bl = utf8ByteLength(val);
      if (bl > CANONICAL_JSON_LIMITS_V1.maxStringUtf8Bytes) {
        throwLimit(`string utf8 bytes ${bl} exceeds maxStringUtf8Bytes ${CANONICAL_JSON_LIMITS_V1.maxStringUtf8Bytes}`);
      }
      return val;
    }
    if (typeof val === "number") {
      if (!Number.isFinite(val)) {
        throw new CanonicalJsonError("Canonical JSON does not accept NaN or Infinity");
      }
      let n: number = val;
      if (Object.is(n, -0)) n = 0;
      if (Number.isInteger(n) && !Number.isSafeInteger(n)) {
        throw new CanonicalJsonError(
          `integer ${String(n)} outside safe integer range; encode as typed string via domain codec`,
        );
      }
      return n;
    }
    if (typeof val === "undefined") {
      throw new CanonicalJsonError("Canonical JSON does not accept undefined");
    }
    if (typeof val === "bigint") {
      throw new CanonicalJsonError("Canonical JSON does not accept bigint");
    }
    if (typeof val === "function") {
      throw new CanonicalJsonError("Canonical JSON does not accept function");
    }
    if (typeof val === "symbol") {
      throw new CanonicalJsonError("Canonical JSON does not accept symbol");
    }
    if (val instanceof Date) {
      throw new CanonicalJsonError(
        "Date instances must be encoded as RFC3339 UTC millisecond strings, not Date objects",
      );
    }
    if (Array.isArray(val)) {
      if (Object.getPrototypeOf(val) !== Array.prototype) {
        throw new CanonicalJsonError("Canonical JSON does not accept array subclasses");
      }
      if (seen.has(val)) throw new CanonicalJsonError("circular reference in array");
      seen.add(val);
      if (val.length > CANONICAL_JSON_LIMITS_V1.maxArrayItems) {
        throwLimit(
          `array length ${val.length} exceeds maxArrayItems ${CANONICAL_JSON_LIMITS_V1.maxArrayItems}`,
        );
      }
      if (Object.getOwnPropertySymbols(val).length > 0) {
        throw new CanonicalJsonError("Canonical JSON does not accept symbol keys");
      }
      const names = Object.getOwnPropertyNames(val);
      if (names.length !== val.length + 1) {
        throw new CanonicalJsonError("Canonical JSON arrays must be dense and cannot contain extra properties");
      }
      const out: unknown[] = new Array(val.length);
      for (let i = 0; i < val.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(val, String(i));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new CanonicalJsonError("Canonical JSON arrays must contain enumerable data properties");
        }
        out[i] = visit(descriptor.value, depth + 1);
      }
      seen.delete(val);
      return out;
    }
    if (typeof val === "object") {
      if (!isPlainObject(val)) {
        throw new CanonicalJsonError(
          "Canonical JSON does not accept class, Map, Set, or non-plain object instances",
        );
      }
      const obj = val as Record<string, unknown>;
      if (seen.has(obj)) throw new CanonicalJsonError("circular reference in object");
      seen.add(obj);
      if (Object.getOwnPropertySymbols(obj).length > 0) {
        throw new CanonicalJsonError("Canonical JSON does not accept symbol keys");
      }
      const keys = Object.keys(obj);
      if (keys.length > CANONICAL_JSON_LIMITS_V1.maxObjectMembers) {
        throwLimit(
          `object members ${keys.length} exceeds maxObjectMembers ${CANONICAL_JSON_LIMITS_V1.maxObjectMembers}`,
        );
      }
      if (
        Object.hasOwn(obj, "__proto__") ||
        Object.hasOwn(obj, "constructor") ||
        Object.hasOwn(obj, "prototype")
      ) {
        throw new CanonicalJsonError(
          "Canonical JSON does not accept objects with __proto__, constructor, or prototype as own keys",
        );
      }
      keys.sort(compareByte);
      const out = Object.create(null) as Record<string, unknown>;
      for (const key of keys) {
        if (hasLoneSurrogate(key)) {
          throw new CanonicalJsonError(`property name contains lone surrogate: ${JSON.stringify(key)}`);
        }
        const keyBytes = utf8ByteLength(key);
        if (keyBytes > CANONICAL_JSON_LIMITS_V1.maxPropertyNameUtf8Bytes) {
          throwLimit(
            `property name utf8 bytes ${keyBytes} exceeds maxPropertyNameUtf8Bytes ${CANONICAL_JSON_LIMITS_V1.maxPropertyNameUtf8Bytes}`,
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(obj, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new CanonicalJsonError("Canonical JSON does not accept accessors");
        }
        out[key] = visit(descriptor.value, depth + 1);
      }
      seen.delete(obj);
      return out;
    }
    throw new CanonicalJsonError(`Canonical JSON does not accept values of type ${typeof val}`);
  };

  return visit(value, 0);
}

export function canonicalJsonString(value: unknown): string {
  const canonical = canonicalizeValue(value);
  const json = JSON.stringify(canonical);
  if (json === undefined) {
    throw new CanonicalJsonError("Canonical JSON is not serializable");
  }
  const bytes = utf8ByteLength(json);
  if (bytes > CANONICAL_JSON_LIMITS_V1.maxUtf8Bytes) {
    throwLimit(`canonical JSON bytes ${bytes} exceeds maxUtf8Bytes ${CANONICAL_JSON_LIMITS_V1.maxUtf8Bytes}`);
  }
  return json;
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  const json = canonicalJsonString(value);
  return utf8Encoder.encode(json);
}

export function canonicalSha256Bytes(value: unknown): Uint8Array {
  return sha256Bytes(canonicalJsonBytes(value));
}

export function canonicalSha256Hex(value: unknown): string {
  return sha256Hex(canonicalJsonBytes(value));
}

export function decodeCanonicalJson(json: string | Uint8Array): unknown {
  let str: string;
  if (json instanceof Uint8Array) {
    if (json.byteLength > CANONICAL_JSON_LIMITS_V1.maxUtf8Bytes) {
      throwLimit(
        `input utf8 bytes ${json.byteLength} exceeds maxUtf8Bytes ${CANONICAL_JSON_LIMITS_V1.maxUtf8Bytes}`,
      );
    }
    try {
      str = new TextDecoder("utf-8", { fatal: true }).decode(json);
    } catch {
      throw new CanonicalJsonError("invalid UTF-8 bytes");
    }
  } else if (typeof json === "string") {
    const bl = utf8ByteLength(json);
    if (bl > CANONICAL_JSON_LIMITS_V1.maxUtf8Bytes) {
      throwLimit(`input utf8 bytes ${bl} exceeds maxUtf8Bytes ${CANONICAL_JSON_LIMITS_V1.maxUtf8Bytes}`);
    }
    str = json;
  } else {
    throw new CanonicalJsonError("decodeCanonicalJson expects string or Uint8Array");
  }

  const len = str.length;
  let pos = 0;
  let totalNodes = 0;

  const error = (msg: string): never => {
    throw new CanonicalJsonError(msg);
  };
  const limit = (msg: string): never => {
    throw new CanonicalJsonError(msg, { code: SERIALIZATION_LIMIT_EXCEEDED_ERROR });
  };
  const skipWs = (): void => {
    while (pos < len) {
      const c = str.charCodeAt(pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++;
      else break;
    }
  };

  const parseStringRaw = (): string => {
    if (pos >= len || str[pos] !== '"') error("expected string");
    pos++;
    let result = "";
    let segmentStart = pos;
    while (pos < len) {
      const ch = str[pos]!;
      if (ch === '"') {
        result += str.slice(segmentStart, pos);
        pos++;
        return result;
      }
      if (ch === "\\") {
        result += str.slice(segmentStart, pos);
        if (pos + 1 >= len) error("incomplete escape");
        const esc = str[pos + 1]!;
        if (esc === '"' || esc === "\\" || esc === "/") {
          result += esc;
          pos += 2;
        } else if (esc === "b") {
          result += "\b";
          pos += 2;
        } else if (esc === "f") {
          result += "\f";
          pos += 2;
        } else if (esc === "n") {
          result += "\n";
          pos += 2;
        } else if (esc === "r") {
          result += "\r";
          pos += 2;
        } else if (esc === "t") {
          result += "\t";
          pos += 2;
        } else if (esc === "u") {
          if (pos + 5 >= len) error("incomplete unicode escape");
          const hex = str.slice(pos + 2, pos + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) error("invalid unicode escape");
          const code = parseInt(hex, 16);
          result += String.fromCharCode(code);
          pos += 6;
        } else {
          error(`invalid escape \\${esc}`);
        }
        segmentStart = pos;
      } else {
        const code = ch.charCodeAt(0);
        if (code <= 0x1f) error("unescaped control character in string");
        pos++;
      }
    }
    return error("unterminated string");
  };

  const parseNumberRaw = (): number => {
    const start = pos;
    if (str[pos] === "-") {
      pos++;
      if (pos >= len) error("invalid number");
    }
    const first = str[pos]!;
    if (first === "0") {
      pos++;
      if (pos < len) {
        const nxt = str[pos]!;
        if (nxt >= "0" && nxt <= "9") error("leading zero not allowed");
      }
    } else if (first >= "1" && first <= "9") {
      pos++;
      while (pos < len) {
        const ch = str[pos]!;
        if (ch >= "0" && ch <= "9") pos++;
        else break;
      }
    } else {
      error("invalid number");
    }
    if (pos < len && str[pos] === ".") {
      pos++;
      if (pos >= len) error("fraction requires digit");
      const ch = str[pos]!;
      if (!(ch >= "0" && ch <= "9")) error("fraction requires digit");
      while (pos < len) {
        const ch2 = str[pos]!;
        if (ch2 >= "0" && ch2 <= "9") pos++;
        else break;
      }
    }
    if (pos < len && (str[pos] === "e" || str[pos] === "E")) {
      pos++;
      if (pos < len && (str[pos] === "+" || str[pos] === "-")) pos++;
      if (pos >= len) error("exponent requires digit");
      const ch = str[pos]!;
      if (!(ch >= "0" && ch <= "9")) error("exponent requires digit");
      while (pos < len) {
        const ch2 = str[pos]!;
        if (ch2 >= "0" && ch2 <= "9") pos++;
        else break;
      }
    }
    const numStr = str.slice(start, pos);
    const num = Number(numStr);
    if (!Number.isFinite(num)) error("non-finite number");
    if (Number.isInteger(num) && !Number.isSafeInteger(num)) {
      throw new CanonicalJsonError(
        `integer ${numStr} outside safe integer range; encode as typed string via domain codec`,
      );
    }
    if (Object.is(num, -0)) return 0;
    return num;
  };

  const parseValue = (depth: number): unknown => {
    if (depth > CANONICAL_JSON_LIMITS_V1.maxDepth) {
      limit(`canonical JSON depth ${depth} exceeds maxDepth ${CANONICAL_JSON_LIMITS_V1.maxDepth}`);
    }
    totalNodes++;
    if (totalNodes > CANONICAL_JSON_LIMITS_V1.maxTotalNodes) {
      limit(
        `canonical JSON total nodes ${totalNodes} exceeds maxTotalNodes ${CANONICAL_JSON_LIMITS_V1.maxTotalNodes}`,
      );
    }
    skipWs();
    if (pos >= len) error("unexpected end of JSON");
    const ch = str[pos]!;
    if (ch === '"') {
      const s = parseStringRaw();
      if (hasLoneSurrogate(s)) error("string contains lone surrogate");
      const bl = utf8ByteLength(s);
      if (bl > CANONICAL_JSON_LIMITS_V1.maxStringUtf8Bytes) {
        limit(`string utf8 bytes ${bl} exceeds maxStringUtf8Bytes ${CANONICAL_JSON_LIMITS_V1.maxStringUtf8Bytes}`);
      }
      return s;
    }
    if (ch === "{") return parseObject(depth);
    if (ch === "[") return parseArray(depth);
    if (ch === "t") {
      if (str.startsWith("true", pos)) {
        pos += 4;
        return true;
      }
      error("invalid token");
    }
    if (ch === "f") {
      if (str.startsWith("false", pos)) {
        pos += 5;
        return false;
      }
      error("invalid token");
    }
    if (ch === "n") {
      if (str.startsWith("null", pos)) {
        pos += 4;
        return null;
      }
      error("invalid token");
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      return parseNumberRaw();
    }
    return error(`unexpected token ${JSON.stringify(ch)}`);
  };

  const parseArray = (depth: number): unknown[] => {
    if (str[pos] !== "[") error("expected [");
    pos++;
    skipWs();
    const arr: unknown[] = [];
    if (pos < len && str[pos] === "]") {
      pos++;
      return arr;
    }
    while (true) {
      if (arr.length >= CANONICAL_JSON_LIMITS_V1.maxArrayItems) {
        limit(`array items ${arr.length + 1} exceeds maxArrayItems ${CANONICAL_JSON_LIMITS_V1.maxArrayItems}`);
      }
      const val = parseValue(depth + 1);
      arr.push(val);
      skipWs();
      if (pos >= len) error("unterminated array");
      const c = str[pos]!;
      if (c === "]") {
        pos++;
        break;
      }
      if (c !== ",") error("expected , or ] in array");
      pos++;
      skipWs();
      if (pos < len && str[pos] === "]") error("trailing comma in array");
    }
    return arr;
  };

  const parseObject = (depth: number): Record<string, unknown> => {
    if (str[pos] !== "{") error("expected {");
    pos++;
    skipWs();
    const obj = Object.create(null) as Record<string, unknown>;
    const seenKeys = new Set<string>();
    let memberCount = 0;
    if (pos < len && str[pos] === "}") {
      pos++;
      return obj;
    }
    while (true) {
      skipWs();
      if (pos >= len || str[pos] !== '"') error("object key must be string");
      const key = parseStringRaw();
      if (hasLoneSurrogate(key)) error("property name contains lone surrogate");
      const keyBytes = utf8ByteLength(key);
      if (keyBytes > CANONICAL_JSON_LIMITS_V1.maxPropertyNameUtf8Bytes) {
        limit(
          `property name utf8 bytes ${keyBytes} exceeds maxPropertyNameUtf8Bytes ${CANONICAL_JSON_LIMITS_V1.maxPropertyNameUtf8Bytes}`,
        );
      }
      if (seenKeys.has(key)) {
        throw new CanonicalJsonError(`duplicate object key: ${JSON.stringify(key)}`);
      }
      seenKeys.add(key);
      memberCount++;
      if (memberCount > CANONICAL_JSON_LIMITS_V1.maxObjectMembers) {
        limit(
          `object members ${memberCount} exceeds maxObjectMembers ${CANONICAL_JSON_LIMITS_V1.maxObjectMembers}`,
        );
      }
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new CanonicalJsonError(`object key ${JSON.stringify(key)} is not allowed`);
      }
      skipWs();
      if (pos >= len || str[pos] !== ":") error("expected : after object key");
      pos++;
      const val = parseValue(depth + 1);
      obj[key] = val;
      skipWs();
      if (pos >= len) error("unterminated object");
      const c = str[pos]!;
      if (c === "}") {
        pos++;
        break;
      }
      if (c !== ",") error("expected , or } in object");
      pos++;
      skipWs();
      if (pos < len && str[pos] === "}") error("trailing comma in object");
    }
    return obj;
  };

  skipWs();
  if (pos >= len) error("empty JSON");
  const result = parseValue(0);
  skipWs();
  if (pos !== len) error("trailing characters after JSON value");
  return result;
}
