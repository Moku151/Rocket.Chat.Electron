import {
  Box,
  SearchInput,
  Icon,
  Button,
  ButtonGroup,
  Select,
  Tile,
  Throbber,
  CheckBox,
} from '@rocket.chat/fuselage';
import {
  useLocalStorage,
  useDebouncedValue,
} from '@rocket.chat/fuselage-hooks';
import { ipcRenderer } from 'electron';
import type { ChangeEvent, Key } from 'react';
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { VirtuosoHandle } from 'react-virtuoso';
import { Virtuoso } from 'react-virtuoso';

import { LogEntry } from './LogEntry';
import {
  ACTION_FEEDBACK_DISPLAY_MS,
  AUTO_REFRESH_INTERVAL_MS,
  AUTO_SCROLL_GUARD_MS,
  SCROLL_DELAY_MS,
  SEARCH_DEBOUNCE_MS,
  VIRTUOSO_OVERSCAN,
} from './constants';
import { parseLogLines } from './parseLogs';
import {
  type LogLevel,
  type LogEntryType,
  type ReadLogsResponse,
  type ReadLogsTailResponse,
  type SaveLogsResponse,
  type SelectFileResponse,
  type ClearLogsResponse,
  isAtLeastLevel,
} from './types';

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
};

const formatDateRange = (
  oldestTime: number | null,
  newestTime: number | null,
  noEntriesLabel: string
): string => {
  if (oldestTime === null || newestTime === null) {
    return noEntriesLabel;
  }
  const oldestDate = new Date(oldestTime);
  const newestDate = new Date(newestTime);
  if (oldestDate.toDateString() === newestDate.toDateString()) {
    return `${oldestDate.toLocaleTimeString()} - ${newestDate.toLocaleTimeString()}`;
  }
  return `${oldestDate.toLocaleString()} - ${newestDate.toLocaleString()}`;
};

function LogViewerWindow() {
  const { t } = useTranslation();
  const [searchFilter, setSearchFilter] = useState('');
  const debouncedSearchFilter = useDebouncedValue(
    searchFilter,
    SEARCH_DEBOUNCE_MS
  );
  const [logEntries, setLogEntries] = useState<LogEntryType[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{
    kind: 'copied' | 'saved' | 'error';
    detail?: string;
  } | null>(null);
  const [pendingNewEntryCount, setPendingNewEntryCount] = useState(0);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const lastModifiedTimeRef = useRef<number | undefined>(undefined);
  const lastKnownSizeRef = useRef<number>(0);
  const nextEntryIdRef = useRef<number>(0);
  const isAutoScrollingRef = useRef(false);
  const lastAutoScrollAtRef = useRef<number>(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [userHasScrolled, setUserHasScrolled] = useState(false);
  const isSuspendedRef = useRef(false);
  const [showContext, setShowContext] = useLocalStorage(
    'log-show-context',
    true
  );
  const [showServer, setShowServer] = useLocalStorage('log-show-server', true);
  const [serverMapping, setServerMapping] = useState<Record<string, string>>(
    {}
  );
  const [fileInfo, setFileInfo] = useState<{
    size: string;
    totalEntries: number;
    totalEntriesInFile?: number;
    lastModified: string;
    dateRange: string;
    lastModifiedTime?: number;
    oldestTime: number | null;
    newestTime: number | null;
  } | null>(null);
  const [currentLogFile, setCurrentLogFile] = useState<{
    filePath?: string;
    fileName: string;
    isDefaultLog: boolean;
  }>({
    fileName: 'main.log',
    isDefaultLog: true,
  });

  const entryLimitOptions = useMemo<[string, string][]>(
    () => [
      ['100', t('logViewer.filters.entryLimit.last100')],
      ['500', t('logViewer.filters.entryLimit.last500')],
      ['1000', t('logViewer.filters.entryLimit.last1000')],
      ['5000', t('logViewer.filters.entryLimit.last5000')],
      ['all', t('logViewer.filters.entryLimit.all')],
    ],
    [t]
  );

  const [entryLimit, setEntryLimit] = useLocalStorage<
    (typeof entryLimitOptions)[number][0]
  >('log-entry-limit', '100');

  const handleSearchFilterChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setSearchFilter(event.target.value);
    },
    [setSearchFilter]
  );

  const levelFilterOptions = useMemo<[LogLevel | 'all', string][]>(
    () => [
      ['all', t('logViewer.filters.level.all')],
      ['silly', t('logViewer.filters.level.silly')],
      ['verbose', t('logViewer.filters.level.verbose')],
      ['debug', t('logViewer.filters.level.debug')],
      ['info', t('logViewer.filters.level.info')],
      ['warn', t('logViewer.filters.level.warn')],
      ['error', t('logViewer.filters.level.error')],
    ],
    [t]
  );

  const [levelFilter, setLevelFilter] = useLocalStorage<
    (typeof levelFilterOptions)[number][0]
  >('log-level', 'all');

  const handleLevelFilterChange = useCallback(
    (value: Key) => {
      setLevelFilter(String(value) as LogLevel | 'all');
    },
    [setLevelFilter]
  );

  const contextFilterOptions = useMemo<[string, string][]>(
    () => [
      ['all', t('logViewer.filters.context.all')],
      ['main', t('logViewer.filters.context.main')],
      ['renderer', t('logViewer.filters.context.renderer')],
      ['webview', t('logViewer.filters.context.webview')],
      ['videocall', t('logViewer.filters.context.videocall')],
      ['outlook', t('logViewer.filters.context.outlook')],
      ['auth', t('logViewer.filters.context.auth')],
      ['updates', t('logViewer.filters.context.updates')],
      ['notifications', t('logViewer.filters.context.notifications')],
      ['servers', t('logViewer.filters.context.servers')],
      ['ipc', t('logViewer.filters.context.ipc')],
    ],
    [t]
  );

  const [contextFilter, setContextFilter] = useLocalStorage<
    (typeof contextFilterOptions)[number][0]
  >('log-context', 'all');

  const handleContextFilterChange = useCallback(
    (value: Key) => {
      setContextFilter(String(value));
    },
    [setContextFilter]
  );

  const serverFilterOptions = useMemo<[string, string][]>(() => {
    const options: [string, string][] = [
      ['all', t('logViewer.filters.server.all')],
    ];
    Object.entries(serverMapping).forEach(([hostname, name]) => {
      options.push([hostname, name || hostname]);
    });
    return options;
  }, [serverMapping, t]);

  const [serverFilter, setServerFilter] = useLocalStorage<string>(
    'log-server',
    'all'
  );

  // Reset persisted server filter if the stored value no longer exists
  useEffect(() => {
    const validKeys = serverFilterOptions.map(([key]) => key);
    if (!validKeys.includes(serverFilter)) {
      setServerFilter('all');
    }
  }, [serverFilter, serverFilterOptions, setServerFilter]);

  const handleServerFilterChange = useCallback(
    (value: Key) => {
      setServerFilter(String(value));
    },
    [setServerFilter]
  );

  const handleEntryLimitChange = useCallback(
    (value: Key) => {
      setEntryLimit(String(value));
    },
    [setEntryLimit]
  );

  const handleClearAll = useCallback((): void => {
    setSearchFilter('');
    setLevelFilter('all');
    setContextFilter('all');
    setServerFilter('all');
    setEntryLimit('100');
  }, [
    setSearchFilter,
    setLevelFilter,
    setContextFilter,
    setServerFilter,
    setEntryLimit,
  ]);

  const loadLogs = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = (await ipcRenderer.invoke(
        'log-viewer-window/read-logs',
        {
          limit: entryLimit === 'all' ? 'all' : parseInt(entryLimit),
          filePath: currentLogFile.isDefaultLog
            ? undefined
            : currentLogFile.filePath,
        }
      )) as ReadLogsResponse;
      if (response?.success && response.logs !== undefined) {
        nextEntryIdRef.current = 0;
        const { entries: parsedLogs, nextId } = parseLogLines(
          response.logs,
          nextEntryIdRef.current
        );
        nextEntryIdRef.current = nextId;
        setLogEntries(parsedLogs);

        setCurrentLogFile({
          filePath: response.filePath,
          fileName: response.fileName || 'main.log',
          isDefaultLog: response.isDefaultLog ?? true,
        });

        const sizeFormatted =
          response.fileSize !== undefined
            ? formatFileSize(response.fileSize)
            : formatFileSize(0);

        let oldestTime: number | null = null;
        let newestTime: number | null = null;
        parsedLogs.forEach((entry) => {
          const time = new Date(entry.timestamp).getTime();
          if (isNaN(time)) return;
          if (oldestTime === null || time < oldestTime) oldestTime = time;
          if (newestTime === null || time > newestTime) newestTime = time;
        });

        const dateRange = formatDateRange(
          oldestTime,
          newestTime,
          t('logViewer.fileInfo.noEntries')
        );

        if (response.fileSize !== undefined) {
          lastKnownSizeRef.current = response.fileSize;
        }

        setFileInfo({
          size: sizeFormatted,
          totalEntries: parsedLogs.length,
          totalEntriesInFile: response.totalEntries,
          lastModified: new Date().toLocaleString(),
          dateRange,
          lastModifiedTime: response.lastModifiedTime,
          oldestTime,
          newestTime,
        });
      } else {
        console.error('Failed to load logs:', response?.error);
        setFileInfo(null);
        setLogEntries([]);
        setError(response?.error || t('logViewer.messages.loadFailed'));
      }
    } catch (err) {
      console.error('Failed to load logs:', err);
      setFileInfo(null);
      setLogEntries([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, [currentLogFile.filePath, currentLogFile.isDefaultLog, entryLimit, t]);

  const filteredLogs = useMemo(() => {
    const lowerSearchFilter = debouncedSearchFilter.toLowerCase();
    const lowerContextFilter = contextFilter.toLowerCase();
    const lowerServerFilter = serverFilter.toLowerCase();

    return logEntries.filter((entry) => {
      const matchesSearch =
        !debouncedSearchFilter || entry.searchText.includes(lowerSearchFilter);

      const matchesLevel =
        levelFilter === 'all' || isAtLeastLevel(entry.level, levelFilter);

      const matchesContext =
        contextFilter === 'all' ||
        entry.contextTags.some((tag) => tag.startsWith(lowerContextFilter));

      const matchesServer =
        serverFilter === 'all' ||
        entry.contextTags.some((tag) => tag === lowerServerFilter) ||
        entry.rawLower.includes(lowerServerFilter);

      return matchesSearch && matchesLevel && matchesContext && matchesServer;
    });
  }, [
    logEntries,
    debouncedSearchFilter,
    levelFilter,
    contextFilter,
    serverFilter,
  ]);

  useEffect(() => {
    lastModifiedTimeRef.current = fileInfo?.lastModifiedTime;
  }, [fileInfo?.lastModifiedTime]);

  useEffect(() => {
    if (!actionFeedback) return undefined;
    const timeoutId = setTimeout(() => {
      setActionFeedback(null);
    }, ACTION_FEEDBACK_DISPLAY_MS);
    return () => clearTimeout(timeoutId);
  }, [actionFeedback]);

  // Fetch server-N → workspace name mapping from the main process
  useEffect(() => {
    const fetchMapping = async () => {
      try {
        const response = (await ipcRenderer.invoke(
          'log-viewer-window/get-server-mapping'
        )) as { success: boolean; mapping: Record<string, string> };
        if (response?.success) {
          setServerMapping(response.mapping);
        }
      } catch {
        // Non-critical: mapping not available yet
      }
    };
    fetchMapping();
    const interval = setInterval(fetchMapping, 30_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    loadLogs();
  }, [loadLogs, currentLogFile.filePath, currentLogFile.isDefaultLog]);

  const checkForUpdates = useCallback(async () => {
    if (!isStreaming || !currentLogFile.isDefaultLog) return;

    try {
      const statResponse = (await ipcRenderer.invoke(
        'log-viewer-window/stat-log',
        { filePath: undefined }
      )) as { success: boolean; lastModifiedTime?: number; size?: number };

      if (!statResponse?.success || !statResponse.lastModifiedTime) return;

      const currentModTime = lastModifiedTimeRef.current;
      if (!currentModTime || statResponse.lastModifiedTime <= currentModTime)
        return;

      const currentSize = statResponse.size ?? 0;
      const previousSize = lastKnownSizeRef.current;

      // File was truncated/rotated (or cleared) — full re-read
      if (currentSize < previousSize) {
        loadLogs();
        return;
      }

      // No new bytes — just a timestamp change (e.g. chmod)
      if (currentSize === previousSize) {
        lastModifiedTimeRef.current = statResponse.lastModifiedTime;
        return;
      }

      // Incremental read: only fetch new bytes appended since last read
      const tailResponse = (await ipcRenderer.invoke(
        'log-viewer-window/read-logs-tail',
        { fromByte: previousSize }
      )) as ReadLogsTailResponse;

      if (tailResponse?.success) {
        if (tailResponse.logs) {
          const { entries: newEntries, nextId } = parseLogLines(
            tailResponse.logs,
            nextEntryIdRef.current
          );
          nextEntryIdRef.current = nextId;
          if (newEntries.length > 0) {
            setLogEntries((prev) => {
              // newEntries are already reversed (newest first)
              // Prepend them to existing entries
              return [...newEntries, ...prev];
            });

            if (isSuspendedRef.current) {
              setPendingNewEntryCount((prev) => prev + newEntries.length);
            }

            let newestTime: number | null = null;
            newEntries.forEach((entry) => {
              const time = new Date(entry.timestamp).getTime();
              if (isNaN(time)) return;
              if (newestTime === null || time > newestTime) newestTime = time;
            });

            setFileInfo((prev) => {
              if (!prev) return prev;
              const nextOldestTime = prev.oldestTime;
              const nextNewestTime =
                newestTime !== null &&
                (prev.newestTime === null || newestTime > prev.newestTime)
                  ? newestTime
                  : prev.newestTime;

              return {
                ...prev,
                totalEntries: prev.totalEntries + newEntries.length,
                totalEntriesInFile:
                  (prev.totalEntriesInFile ?? 0) + newEntries.length,
                lastModified: new Date().toLocaleString(),
                lastModifiedTime: tailResponse.lastModifiedTime,
                oldestTime: nextOldestTime,
                newestTime: nextNewestTime,
                dateRange: formatDateRange(
                  nextOldestTime,
                  nextNewestTime,
                  t('logViewer.fileInfo.noEntries')
                ),
              };
            });
          }
        }

        // newSize tracks bytes actually consumed (up to the last complete
        // line), which may trail the real file size when a write is in
        // flight — the remainder is picked up on the next poll.
        if (tailResponse.newSize !== undefined) {
          lastKnownSizeRef.current = tailResponse.newSize;
        }
        lastModifiedTimeRef.current = tailResponse.lastModifiedTime;
      }
    } catch (error) {
      console.error('Failed to check for updates:', error);
    }
  }, [isStreaming, currentLogFile.isDefaultLog, loadLogs, t]);

  useEffect(() => {
    if (!isStreaming || !currentLogFile.isDefaultLog) return;

    const interval = setInterval(checkForUpdates, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isStreaming, currentLogFile.isDefaultLog, checkForUpdates]);

  useEffect(() => {
    if (autoScroll) {
      setUserHasScrolled(false);
    }
  }, [autoScroll]);

  useEffect(() => {
    isSuspendedRef.current = autoScroll && userHasScrolled;
    if (!isSuspendedRef.current) {
      setPendingNewEntryCount(0);
    }
  }, [autoScroll, userHasScrolled]);

  useEffect(() => {
    if (
      autoScroll &&
      !userHasScrolled &&
      logEntries.length > 0 &&
      virtuosoRef.current
    ) {
      const timeoutId = setTimeout(() => {
        isAutoScrollingRef.current = true;
        lastAutoScrollAtRef.current = Date.now();
        if (virtuosoRef.current && autoScroll && !userHasScrolled) {
          virtuosoRef.current.scrollToIndex({
            index: 0,
            behavior: 'auto',
          });
        }
        isAutoScrollingRef.current = false;
      }, SCROLL_DELAY_MS);

      return () => clearTimeout(timeoutId);
    }
    return undefined;
  }, [logEntries, autoScroll, userHasScrolled]);

  const handleScroll = useCallback(() => {
    if (isAutoScrollingRef.current) return;
    if (Date.now() - lastAutoScrollAtRef.current < AUTO_SCROLL_GUARD_MS) return;
    if (autoScroll && !userHasScrolled) {
      setUserHasScrolled(true);
    }
  }, [autoScroll, userHasScrolled]);

  const handleResumeAutoScroll = useCallback(() => {
    setUserHasScrolled(false);
    setPendingNewEntryCount(0);
    if (virtuosoRef.current) {
      isAutoScrollingRef.current = true;
      lastAutoScrollAtRef.current = Date.now();
      virtuosoRef.current.scrollToIndex({ index: 0, behavior: 'smooth' });
      isAutoScrollingRef.current = false;
    }
  }, []);

  const renderLogEntry = useCallback(
    (_index: number, entry: LogEntryType) => {
      return (
        <LogEntry
          key={entry.id}
          entry={entry}
          showContext={showContext}
          showServer={showServer}
          serverMapping={serverMapping}
          highlightQuery={debouncedSearchFilter}
        />
      );
    },
    [showContext, showServer, serverMapping, debouncedSearchFilter]
  );

  const handleOpenLogFile = useCallback(async () => {
    try {
      const response = (await ipcRenderer.invoke(
        'log-viewer-window/select-log-file'
      )) as SelectFileResponse;
      if (response?.success && response.filePath) {
        setLogEntries([]);
        setFileInfo(null);

        setIsStreaming(false);

        setCurrentLogFile({
          filePath: response.filePath,
          fileName: response.fileName || 'custom.log',
          isDefaultLog: false,
        });
      }
    } catch (error) {
      console.error('Failed to open log file:', error);
    }
  }, []);

  const handleOpenDefaultLog = useCallback(() => {
    setLogEntries([]);
    setFileInfo(null);

    setCurrentLogFile({
      filePath: undefined,
      fileName: 'main.log',
      isDefaultLog: true,
    });
  }, []);

  const handleRefresh = useCallback(() => {
    loadLogs();
  }, [loadLogs]);

  const handleRevealLogFile = useCallback(async () => {
    try {
      const response = (await ipcRenderer.invoke(
        'log-viewer-window/reveal-log-file',
        {
          filePath: currentLogFile.isDefaultLog
            ? undefined
            : currentLogFile.filePath,
        }
      )) as { success: boolean; error?: string };
      if (!response?.success) {
        console.error('Failed to reveal log file:', response?.error);
      }
    } catch (error) {
      console.error('Failed to reveal log file:', error);
    }
  }, [currentLogFile.isDefaultLog, currentLogFile.filePath]);

  const handleClearLogs = useCallback(async () => {
    if (!currentLogFile.isDefaultLog) {
      return;
    }
    try {
      const confirmed = await ipcRenderer.invoke(
        'log-viewer-window/confirm-clear-logs'
      );
      if (!confirmed) return;

      const response = (await ipcRenderer.invoke(
        'log-viewer-window/clear-logs'
      )) as ClearLogsResponse;
      if (response?.success) {
        lastKnownSizeRef.current = 0;
        loadLogs();
      }
    } catch (error) {
      console.error('Failed to clear logs:', error);
    }
  }, [currentLogFile.isDefaultLog, loadLogs]);

  const handleToggleStreaming = useCallback(() => {
    setIsStreaming(!isStreaming);
  }, [isStreaming]);

  const handleCopyLogs = useCallback(() => {
    const logText = filteredLogs.map((entry) => entry.raw).join('\n');
    navigator.clipboard
      .writeText(logText)
      .then(() => {
        setActionFeedback({ kind: 'copied' });
      })
      .catch((error) => {
        console.error('Failed to copy logs to clipboard:', error);
        setActionFeedback({
          kind: 'error',
          detail: error instanceof Error ? error.message : String(error),
        });
      });
  }, [filteredLogs]);

  const handleSaveLogs = useCallback(async () => {
    try {
      const logText = filteredLogs.map((entry) => entry.raw).join('\n');
      const timestamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/:/g, '-');
      const response = (await ipcRenderer.invoke(
        'log-viewer-window/save-logs',
        {
          content: logText,
          defaultFileName: `rocketchat_${timestamp}.zip`,
        }
      )) as SaveLogsResponse;

      if (response?.success) {
        setActionFeedback({ kind: 'saved', detail: response.filePath });
      } else if (response?.canceled) {
        // User canceled the save dialog — not an error, no feedback needed
      } else if (response?.error) {
        console.error('Failed to save logs:', response.error);
        setActionFeedback({ kind: 'error', detail: response.error });
      }
    } catch (error) {
      console.error('Failed to save logs:', error);
      setActionFeedback({
        kind: 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }, [filteredLogs]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        const searchInput = document.querySelector(
          'input[type="search"]'
        ) as HTMLInputElement;
        searchInput?.focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSaveLogs();
      }
      if (e.key === 'Escape' && searchFilter) {
        setSearchFilter('');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchFilter, setSearchFilter, handleSaveLogs]);

  const handleClose = useCallback(() => {
    ipcRenderer.invoke('log-viewer-window/close-requested');
  }, []);

  return (
    <Box
      display='flex'
      flexDirection='column'
      height='100vh'
      width='100%'
      backgroundColor='surface-light'
    >
      <Box
        minHeight='x64'
        padding='x24'
        display='flex'
        flexDirection='row'
        flexWrap='nowrap'
        alignItems='center'
        borderBlockEnd='1px solid var(--rcx-color-stroke-light)'
        backgroundColor='surface-tint'
      >
        <Box
          display='flex'
          flexDirection='row'
          alignItems='center'
          flexGrow={1}
        >
          <Icon
            name='list-alt'
            size='x20'
            color='default'
            aria-label={t('logViewer.aria.logIcon')}
          />
          <Box fontScale='h4' marginInlineStart='x8' color='default'>
            {t('logViewer.title')}
          </Box>
          <Box
            display='flex'
            flexDirection='column'
            alignItems='flex-start'
            color='hint'
            fontSize='x12'
            marginInlineStart='x16'
          >
            <Box display='flex' alignItems='center' marginBlockEnd='x4'>
              <Icon
                name={currentLogFile.isDefaultLog ? 'home' : 'attachment'}
                size='x12'
              />
              <Box
                marginInlineStart='x4'
                fontWeight='bold'
                color={currentLogFile.isDefaultLog ? 'default' : 'info'}
              >
                {currentLogFile.fileName}
                {!currentLogFile.isDefaultLog &&
                  ` (${t('logViewer.fileInfo.custom')})`}
              </Box>
            </Box>
            {fileInfo && (
              <Box display='flex' alignItems='center' flexWrap='wrap'>
                <Box marginInlineEnd='x8' display='flex' alignItems='center'>
                  <Icon name='hash' size='x12' />
                  <Box marginInlineStart='x4'>
                    {fileInfo.totalEntriesInFile &&
                    fileInfo.totalEntriesInFile !== fileInfo.totalEntries
                      ? t('logViewer.fileInfo.entriesOfTotal', {
                          count: fileInfo.totalEntries,
                          total: fileInfo.totalEntriesInFile,
                        })
                      : t('logViewer.fileInfo.entries', {
                          count: fileInfo.totalEntries,
                        })}
                  </Box>
                </Box>
                <Box marginInlineEnd='x8' display='flex' alignItems='center'>
                  <Icon name='file' size='x12' />
                  <Box marginInlineStart='x4'>{fileInfo.size}</Box>
                </Box>
                <Box marginInlineEnd='x8' display='flex' alignItems='center'>
                  <Icon name='clock' size='x12' />
                  <Box marginInlineStart='x4'>{fileInfo.dateRange}</Box>
                </Box>
              </Box>
            )}
          </Box>
        </Box>
        <ButtonGroup>
          <Button onClick={handleOpenLogFile}>
            <Icon name='folder' size='x16' />
            {t('logViewer.buttons.openLogFile')}
          </Button>
          {!currentLogFile.isDefaultLog && (
            <Button onClick={handleOpenDefaultLog}>
              <Icon name='home' size='x16' />
              {t('logViewer.buttons.defaultLog')}
            </Button>
          )}
          <Button onClick={handleRefresh} disabled={isLoading}>
            <Icon
              name='refresh'
              size='x16'
              aria-label={t('logViewer.buttons.refresh')}
            />
            {t('logViewer.buttons.refresh')}
          </Button>
          <Button
            onClick={handleToggleStreaming}
            primary={isStreaming}
            disabled={!currentLogFile.isDefaultLog}
          >
            <Icon name={isStreaming ? 'pause' : 'play'} size='x16' />
            {isStreaming
              ? t('logViewer.buttons.stopAutoRefresh')
              : t('logViewer.buttons.autoRefresh')}
          </Button>
          <Button onClick={handleRevealLogFile}>
            <Icon name='arrow-up-box' size='x16' />
            {t('logViewer.buttons.showInFolder')}
          </Button>
          <Button onClick={handleCopyLogs}>
            <Icon name='copy' size='x16' />
            {t('logViewer.buttons.copy')}
          </Button>
          <Button onClick={handleSaveLogs}>
            <Icon name='download' size='x16' />
            {t('logViewer.buttons.save')}
          </Button>
          <Button
            onClick={handleClearLogs}
            danger
            disabled={!currentLogFile.isDefaultLog}
          >
            <Icon name='trash' size='x16' />
            {t('logViewer.buttons.clear')}
          </Button>
          <Button onClick={handleClose}>
            <Icon name='cross' size='x16' />
            {t('logViewer.buttons.close')}
          </Button>
        </ButtonGroup>
      </Box>

      {actionFeedback && (
        <Box
          padding='x8'
          paddingInline='x24'
          display='flex'
          alignItems='center'
          fontScale='c1'
          backgroundColor={
            actionFeedback.kind === 'error'
              ? 'status-background-danger'
              : 'status-background-success'
          }
        >
          <Icon
            name={actionFeedback.kind === 'error' ? 'warning' : 'check'}
            size='x12'
          />
          <Box marginInlineStart='x4'>
            {actionFeedback.kind === 'copied' &&
              t('logViewer.messages.copiedToClipboard')}
            {actionFeedback.kind === 'saved' &&
              t('logViewer.messages.savedSuccessfully')}
            {actionFeedback.kind === 'error' &&
              (actionFeedback.detail
                ? t('logViewer.messages.actionFailedWithDetail', {
                    detail: actionFeedback.detail,
                  })
                : t('logViewer.messages.actionFailed'))}
          </Box>
        </Box>
      )}

      <Box
        padding='x24'
        paddingBlockStart='x12'
        paddingBlockEnd='x12'
        display='flex'
        flexDirection='row'
        flexWrap='wrap'
        alignItems='center'
        justifyContent='space-between'
        borderBlockEnd='1px solid var(--rcx-color-stroke-light)'
        backgroundColor='surface-tint'
      >
        <Box display='flex' alignItems='center' flexWrap='wrap'>
          <Box display='flex' alignItems='center' marginInlineEnd='x16'>
            <CheckBox
              aria-label={t('logViewer.controls.showContext')}
              checked={showContext}
              onChange={() => setShowContext(!showContext)}
            />
            <Box marginInlineStart='x4' display='inline' color='default'>
              {t('logViewer.controls.showContext')}
            </Box>
          </Box>
          <Box display='flex' alignItems='center' marginInlineEnd='x16'>
            <CheckBox
              aria-label={t('logViewer.controls.showServer')}
              checked={showServer}
              onChange={() => setShowServer(!showServer)}
            />
            <Box marginInlineStart='x4' display='inline' color='default'>
              {t('logViewer.controls.showServer')}
            </Box>
          </Box>
          <Box display='flex' alignItems='center'>
            <CheckBox
              aria-label={t('logViewer.controls.autoScrollToTop')}
              checked={autoScroll}
              onChange={() => {
                const newAutoScroll = !autoScroll;
                setAutoScroll(newAutoScroll);
                if (newAutoScroll) {
                  setUserHasScrolled(false);
                  if (filteredLogs.length > 0 && virtuosoRef.current) {
                    setTimeout(() => {
                      isAutoScrollingRef.current = true;
                      lastAutoScrollAtRef.current = Date.now();
                      virtuosoRef.current?.scrollToIndex({
                        index: 0,
                        behavior: 'smooth',
                      });
                      isAutoScrollingRef.current = false;
                    }, 100);
                  }
                }
              }}
            />
            <Box marginInlineStart='x4' display='inline' color='default'>
              {t('logViewer.controls.autoScrollToTop')}
            </Box>
          </Box>
        </Box>
        <Box display='flex' alignItems='center' flexWrap='wrap'>
          <Box marginInlineEnd='x12'>
            <Select
              aria-label={t('logViewer.placeholders.loadAmount')}
              placeholder={t('logViewer.placeholders.loadAmount')}
              value={entryLimit}
              options={entryLimitOptions}
              onChange={handleEntryLimitChange}
              width={180}
            />
          </Box>
          <Box minWidth='x200' marginInlineEnd='x12'>
            <SearchInput
              aria-label={t('logViewer.placeholders.searchLogs')}
              placeholder={t('logViewer.placeholders.searchLogs')}
              value={searchFilter}
              onChange={handleSearchFilterChange}
            />
          </Box>
          <Box marginInlineEnd='x12'>
            <Select
              aria-label={t('logViewer.placeholders.level')}
              placeholder={t('logViewer.placeholders.level')}
              value={levelFilter}
              options={levelFilterOptions}
              onChange={handleLevelFilterChange}
              width={120}
            />
          </Box>
          <Box marginInlineEnd='x12'>
            <Select
              aria-label={t('logViewer.placeholders.context')}
              placeholder={t('logViewer.placeholders.context')}
              value={contextFilter}
              options={contextFilterOptions}
              onChange={handleContextFilterChange}
              width={200}
            />
          </Box>
          {serverFilterOptions.length > 1 && (
            <Box marginInlineEnd='x12'>
              <Select
                aria-label={t('logViewer.filters.server.label')}
                placeholder={t('logViewer.filters.server.all')}
                value={serverFilter}
                options={serverFilterOptions}
                onChange={handleServerFilterChange}
                width={240}
              />
            </Box>
          )}
          <Button onClick={handleClearAll}>
            {t('logViewer.buttons.clearFilters')}
          </Button>
        </Box>
      </Box>

      <Box flexGrow={1} padding='x24' paddingBlockStart='x12'>
        <Tile elevation='2' padding={0} overflow='hidden' height='100%'>
          {isLoading && (
            <Box
              display='flex'
              justifyContent='center'
              alignItems='center'
              height='x400'
              backgroundColor='surface-light'
            >
              <Throbber size='x32' />
            </Box>
          )}
          {!isLoading && error && (
            <Box
              display='flex'
              flexDirection='column'
              justifyContent='center'
              alignItems='center'
              height='100%'
              color='hint'
              backgroundColor='surface-light'
            >
              <Icon name='warning' size='x32' color='danger' />
              <Box marginBlockStart='x8' fontScale='p2' color='danger'>
                {t('logViewer.messages.loadFailed')}
              </Box>
              <Box marginBlockStart='x4' fontScale='c1' color='hint'>
                {error}
              </Box>
              <Box marginBlockStart='x12'>
                <Button onClick={handleRefresh}>
                  {t('logViewer.buttons.retry')}
                </Button>
              </Box>
            </Box>
          )}
          {!isLoading && !error && filteredLogs.length === 0 && (
            <Box
              display='flex'
              flexDirection='column'
              justifyContent='center'
              alignItems='center'
              height='100%'
              color='hint'
              backgroundColor='surface-light'
            >
              <Icon name='list-alt' size='x32' color='hint' />
              <Box marginBlockStart='x8' fontScale='p2'>
                {t('logViewer.messages.noLogsFound')}
              </Box>
              <Box marginBlockStart='x4' fontScale='c1' color='hint'>
                {t('logViewer.messages.adjustFilters')}
              </Box>
            </Box>
          )}
          {!isLoading && !error && filteredLogs.length > 0 && (
            <Box height='100%' position='relative'>
              <Box
                position='absolute'
                insetBlockStart='x8'
                insetInlineEnd='x8'
                zIndex={10}
                pi='x8'
                pb='x4'
                borderRadius='x4'
                bg='tint'
                color='hint'
                fontScale='c1'
              >
                {debouncedSearchFilter
                  ? t('logViewer.fileInfo.matches', {
                      count: filteredLogs.length,
                    })
                  : t('logViewer.fileInfo.entries', {
                      count: filteredLogs.length,
                    })}
              </Box>
              {autoScroll && userHasScrolled && pendingNewEntryCount > 0 && (
                <Box
                  is='button'
                  onClick={handleResumeAutoScroll}
                  position='absolute'
                  insetBlockStart='x8'
                  insetInlineStart='50%'
                  style={{ transform: 'translateX(-50%)', cursor: 'pointer' }}
                  zIndex={10}
                  pi='x12'
                  pb='x6'
                  borderRadius='x24'
                  backgroundColor='status-background-info'
                  color='status-font-on-info'
                  fontScale='c1'
                  display='flex'
                  alignItems='center'
                  border='none'
                >
                  <Icon name='arrow-up' size='x12' />
                  <Box marginInlineStart='x4'>
                    {t('logViewer.messages.newEntriesPaused', {
                      count: pendingNewEntryCount,
                    })}
                  </Box>
                </Box>
              )}
              <Virtuoso
                ref={virtuosoRef}
                data={filteredLogs}
                itemContent={renderLogEntry}
                overscan={VIRTUOSO_OVERSCAN}
                style={{ height: '100%', width: '100%' }}
                onScroll={handleScroll}
              />
            </Box>
          )}
        </Tile>
      </Box>
    </Box>
  );
}

export default LogViewerWindow;
