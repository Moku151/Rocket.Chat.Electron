import { parseLogLines } from '../parseLogs';

describe('parseLogLines', () => {
  it('returns empty entries and unchanged offset for empty input', () => {
    const { entries, nextId } = parseLogLines('', 5);
    expect(entries).toEqual([]);
    expect(nextId).toBe(5);
  });

  it('parses a single-line entry with level and context', () => {
    const line = '[2024-01-01 10:00:00.000] [info] [main] Application started';
    const { entries, nextId } = parseLogLines(line, 0);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'log-0',
      timestamp: '2024-01-01 10:00:00.000',
      level: 'info',
      context: 'main',
      message: 'Application started',
      raw: line,
    });
    expect(nextId).toBe(1);
  });

  it('merges continuation lines (multi-line entries) into the preceding entry', () => {
    const logText = [
      '[2024-01-01 10:00:00.000] [error] [main] Stack trace:',
      '    at foo (foo.js:1:1)',
      '    at bar (bar.js:2:2)',
    ].join('\n');

    const { entries, nextId } = parseLogLines(logText, 0);

    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe(
      'Stack trace:\n    at foo (foo.js:1:1)\n    at bar (bar.js:2:2)'
    );
    expect(entries[0].raw).toBe(logText);
    expect(nextId).toBe(1);
  });

  it('parses multiple entries and reverses them (newest first)', () => {
    const logText = [
      '[2024-01-01 10:00:00.000] [info] [main] First',
      '[2024-01-01 10:00:01.000] [warn] [renderer] Second',
    ].join('\n');

    const { entries, nextId } = parseLogLines(logText, 0);

    expect(entries).toHaveLength(2);
    expect(entries[0].message).toBe('Second');
    expect(entries[1].message).toBe('First');
    expect(nextId).toBe(2);
  });

  it('extracts multiple context tags', () => {
    const line =
      '[2024-01-01 10:00:00.000] [debug] [main] [server-1] Connected';
    const { entries } = parseLogLines(line, 0);

    expect(entries[0].context).toBe('main   server-1');
    expect(entries[0].contextTags).toEqual(['main', 'server-1']);
  });

  it('defaults unparseable levels to info', () => {
    const line = '[2024-01-01 10:00:00.000] [notalevel] [main] Something';
    const { entries } = parseLogLines(line, 0);
    expect(entries[0].level).toBe('info');
  });

  it('produces unique, monotonically increasing ids across two calls (id offset continuity)', () => {
    const firstBatch = '[2024-01-01 10:00:00.000] [info] [main] One';
    const secondBatch = [
      '[2024-01-01 10:00:01.000] [info] [main] Two',
      '[2024-01-01 10:00:02.000] [info] [main] Three',
    ].join('\n');

    const first = parseLogLines(firstBatch, 0);
    expect(first.entries.map((e) => e.id)).toEqual(['log-0']);
    expect(first.nextId).toBe(1);

    const second = parseLogLines(secondBatch, first.nextId);
    // second.entries are reversed (newest first): "Three" (log-2) then "Two" (log-1)
    expect(second.entries.map((e) => e.id)).toEqual(['log-2', 'log-1']);
    expect(second.nextId).toBe(3);

    const allIds = [
      ...first.entries.map((e) => e.id),
      ...second.entries.map((e) => e.id),
    ];
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('precomputes searchText, contextTags and rawLower', () => {
    const line = '[2024-01-01 10:00:00.000] [info] [Main Server-1] HELLO World';
    const { entries } = parseLogLines(line, 0);
    const entry = entries[0];

    expect(entry.searchText).toBe(
      `${entry.message} ${entry.context}`.toLowerCase()
    );
    expect(entry.contextTags).toEqual(entry.context.toLowerCase().split(/\s+/));
    expect(entry.rawLower).toBe(entry.raw.toLowerCase());
  });
});
