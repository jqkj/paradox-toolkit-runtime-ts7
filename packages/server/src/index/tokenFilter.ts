import * as path from "path";

/** 会话内的保守预筛：只跳过肯定无此标识符的文件，精确语义仍由原解析器裁定。 */
export class TokenFilter {
  private tables = new Map<string, Uint32Array>();
  private bytes = 0;
  constructor(private readonly budget = 16 * 1024 * 1024) {}

  private key(file: string): string {
    const resolved = path.resolve(file);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  clear(): void {
    this.tables.clear();
    this.bytes = 0;
  }

  invalidate(file: string): void {
    const key = this.key(file);
    const table = this.tables.get(key);
    if (table) this.bytes -= table.byteLength;
    this.tables.delete(key);
  }

  mayContain(file: string, name: string): boolean {
    const table = this.tables.get(this.key(file));
    if (!table) return true;
    const [a, b] = hashes(name);
    for (let i = 0; i < 7; i++) {
      const bit = ((a + Math.imul(i, b)) >>> 0) % (table.length * 32);
      if ((table[bit >>> 5] & (1 << (bit & 31))) === 0) return false;
    }
    return true;
  }

  add(file: string, content: string): void {
    const key = this.key(file);
    if (this.tables.has(key)) return;
    const words = new Set(content.match(/[A-Za-z0-9_.-]+/g) ?? []);
    const length = Math.max(8, Math.ceil((words.size * 10) / 32));
    // 达到预算后回到原扫描路径，不以缺少缓存推断文件没有引用。
    if (this.bytes + length * 4 > this.budget) return;
    const table = new Uint32Array(length);
    for (const word of words) {
      const [a, b] = hashes(word);
      for (let i = 0; i < 7; i++) {
        const bit = ((a + Math.imul(i, b)) >>> 0) % (length * 32);
        table[bit >>> 5] |= 1 << (bit & 31);
      }
    }
    this.tables.set(key, table);
    this.bytes += table.byteLength;
  }
}

function hashes(word: string): [number, number] {
  let a = 2166136261;
  let b = 5381;
  for (let i = 0; i < word.length; i++) {
    a = Math.imul(a ^ word.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ word.charCodeAt(i);
  }
  return [a >>> 0, (b | 1) >>> 0];
}
