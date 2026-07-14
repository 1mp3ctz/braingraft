import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeFixture({ label = 'src', platform = 'posix', withSecret = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `claudeport-${label}-`));
  const homeDir = path.join(root, platform === 'win' ? 'bob' : 'alice');
  const dir = path.join(homeDir, '.claude');
  const foreignNs = platform === 'win' ? '-Users-alice' : 'C--Users-bob';

  const write = (rel, content) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  write('CLAUDE.md', `# Global rules\n\nAlways use ${homeDir}/bin/tools when available.\n`);
  write('skills/hotelier/SKILL.md', '---\nname: hotelier\n---\n\nQuiet luxury. No scroll animation.\n');
  write('agents/reviewer.md', '---\nname: reviewer\n---\n\nReview code.\n');
  write('commands/ship.md', 'Ship it.\n');
  write('rules/common/testing.md', '# Testing\n\n80% coverage.\n');
  write('hooks/observe.sh', '#!/bin/bash\necho observing\n');
  write('helpers/statusline.cjs', "const home = process.env.HOME;\nconsole.log('status');\n");

  write(
    'settings.json',
    `${JSON.stringify(
      {
        model: 'opus[1m]',
        theme: 'dark',
        effortLevel: 'high',
        statusLine: { type: 'command', command: `node ${homeDir}/.claude/helpers/statusline.cjs` },
        permissions: { allow: ['Bash(git status)'], deny: [] },
        disabledSkills: ['legacy-skill'],
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }]
        },
        enabledPlugins: { 'luminous-glass@luminous-glass': true },
        mcpServers: {
          obsidian: {
            command: `${homeDir}/venv/bin/python`,
            args: [`${homeDir}/.claude/mcp-configs/server.py`],
            env: { OBSIDIAN_API_KEY: 'b4d1f00dfeedfacecafebabe12345678' },
            headers: { Authorization: 'Bearer abc123def456ghi789jkl012mno345pqr' }
          }
        }
      },
      null,
      2
    )}\n`
  );

  write('.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-SECRET-TOKEN-VALUE-do-not-pack' } }));
  write('history.jsonl', '{"session":"local"}\n');
  write('jobs/abc/state.json', '{"junk":true}\n');
  write('cache/blob.bin', 'binary-ish');

  write(`projects/${foreignNs}/memory/MEMORY.md`, '# Memory Index\n\n- [Project X](project_x.md) — the thing I taught Claude.\n');
  write(`projects/${foreignNs}/memory/project_x.md`, '---\nname: project-x\n---\n\nProject X ships on Friday.\n');
  write(`projects/${foreignNs}/sessions/abc.jsonl`, '{"transcript":"private"}\n');

  if (withSecret) {
    write('skills/leaky/SKILL.md', '---\nname: leaky\n---\n\nUse key sk-ant-api03-REALKEY1234567890abcdefghijklmnop for the API.\n');
  }

  return { root, homeDir, dir, foreignNs };
}

export function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch { /* best effort */ }
}
