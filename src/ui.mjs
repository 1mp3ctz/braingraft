import readline from 'node:readline';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const ESC = String.fromCharCode(27);
const wrap = (code) => (s) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : String(s));

export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90')
};

export const sym = {
  ok: c.green('✓'),
  warn: c.yellow('!'),
  bad: c.red('✗'),
  info: c.blue('·'),
  arrow: c.gray('→')
};

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function heading(text) {
  return `\n${c.bold(text)}\n${c.gray('─'.repeat(Math.min(text.length + 8, 60)))}`;
}

export function table(rows, { indent = '  ' } = {}) {
  if (!rows.length) return '';
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      const len = stripAnsi(String(cell)).length;
      widths[i] = Math.max(widths[i] ?? 0, len);
    });
  }
  return rows
    .map((row) =>
      indent +
      row
        .map((cell, i) => {
          const s = String(cell);
          const pad = widths[i] - stripAnsi(s).length;
          return i === row.length - 1 ? s : s + ' '.repeat(pad + 2);
        })
        .join('')
    )
    .join('\n');
}

export function stripAnsi(s) {
  return s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
}

export async function confirm(question, { assumeYes = false } = {}) {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} ${c.gray('[y/N]')} `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export async function askPassphrase(prompt = 'Passphrase: ') {
  if (process.env.CLAUDEPORT_PASSPHRASE) return process.env.CLAUDEPORT_PASSPHRASE;
  if (!process.stdin.isTTY) {
    throw new Error('a passphrase is required; set CLAUDEPORT_PASSPHRASE or run in a terminal');
  }
  process.stdout.write(prompt);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.output.write = () => {};
  const answer = await new Promise((resolve) => rl.question('', resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}
