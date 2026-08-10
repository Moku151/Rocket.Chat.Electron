import type { LogEntryType } from './types';
import { parseLogLevel } from './types';

const LOG_LINE_REGEX = /^\[([^\]]+)\]\s+\[([^\]]+)\]\s*(.*)$/;
const CONTEXT_REGEX = /^(\[[^\]]+\](?:\s*\[[^\]]+\])*)\s*(.*)$/;

const buildEntryDerivedFields = (
  entry: Pick<LogEntryType, 'message' | 'context' | 'raw'>
): Pick<LogEntryType, 'searchText' | 'contextTags' | 'rawLower'> => ({
  searchText: `${entry.message} ${entry.context}`.toLowerCase(),
  contextTags: entry.context.toLowerCase().split(/\s+/),
  rawLower: entry.raw.toLowerCase(),
});

export const parseLogLines = (
  logText: string,
  idOffset: number
): { entries: LogEntryType[]; nextId: number } => {
  if (!logText || logText.trim() === '') {
    return { entries: [], nextId: idOffset };
  }

  const lines = logText.split(/\r?\n/).filter((line: string) => line.trim());
  const entries: LogEntryType[] = [];
  let currentEntry: LogEntryType | null = null;
  let nextId = idOffset;

  lines.forEach((line) => {
    const match = line.match(LOG_LINE_REGEX);

    if (match) {
      const [, timestamp, level, rest] = match;

      const contextMatch = rest.match(CONTEXT_REGEX);
      const context = contextMatch?.[1] || '';
      const message = contextMatch?.[2] || rest;

      if (currentEntry) {
        entries.push(currentEntry);
      }

      const parsedContext = context.replace(/[\[\]]/g, ' ').trim();
      const parsedMessage = message.trim();

      currentEntry = {
        id: `log-${nextId}`,
        timestamp,
        level: parseLogLevel(level),
        context: parsedContext,
        message: parsedMessage,
        raw: line,
        ...buildEntryDerivedFields({
          message: parsedMessage,
          context: parsedContext,
          raw: line,
        }),
      };
      nextId += 1;
    } else if (currentEntry && line.trim()) {
      currentEntry.message += `\n${line}`;
      currentEntry.raw += `\n${line}`;
      const derived = buildEntryDerivedFields(currentEntry);
      currentEntry.searchText = derived.searchText;
      currentEntry.rawLower = derived.rawLower;
    }
  });

  if (currentEntry) {
    entries.push(currentEntry);
  }

  return { entries: entries.reverse(), nextId };
};
