import { readFile, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const libnode = resolve(studioRoot, "android/app/src/main/jniLibs/arm64-v8a/libnode.so");

const size = await stat(libnode).then((s) => s.size).catch(() => 0);
const mb = size / (1024 * 1024);
const bytes = size > 0 ? await readFile(libnode).catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
const sample = bytes.toString("latin1");
const moduleSymbols = {
  sqlite: sample.includes("node:sqlite") || sample.includes("DatabaseSync"),
  crypto: sample.includes("node:crypto") || sample.includes("crypto"),
  net: sample.includes("node:net") || sample.includes("_http_server") || sample.includes("TCPWrap"),
};

console.log(JSON.stringify({
  abi: "arm64-v8a",
  libnode,
  sizeBytes: size,
  sizeMb: Number(mb.toFixed(2)),
  status: size > 0 ? "present" : "missing",
  detectedSymbols: moduleSymbols,
  canStartInkOSWithoutCrypto: false,
  note: "InkOS currently requires crypto for cache keys and runtime hashes. A custom Node build may trim net only if embedded-node startup still exposes http/fetch as required by the Android service. Replace libnode.so through INKOS_ANDROID_NODE_LIB, then rerun this audit and android:apk.",
}, null, 2));

if (size === 0) {
  process.exit(1);
}
