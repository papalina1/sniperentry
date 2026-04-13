import winston from 'winston';
import { LogEntry, LogLevel, WSMessage } from '../types';

// Broadcast function is injected by the WebSocket server after it starts
let broadcastFn: ((msg: WSMessage) => void) | null = null;

export function registerBroadcast(fn: (msg: WSMessage) => void): void {
  broadcastFn = fn;
}

const { combine, timestamp, printf, colorize, errors } = winston.format;

const consoleFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss.SSS' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, component, ...rest }) => {
    const comp = component ? `[${component}]` : '';
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    return `${ts} ${level} ${comp} ${message}${extra}`;
  })
);

const fileFormat = combine(
  timestamp(),
  errors({ stack: true }),
  winston.format.json()
);

const winstonLogger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    new winston.transports.File({
      filename: './data/solsniper.log',
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 3,
      tailable: true,
    }),
  ],
});

// In-memory circular buffer for the /api/logs endpoint
const logBuffer: LogEntry[] = [];
const LOG_BUFFER_SIZE = 500;

function emit(level: LogLevel, component: string, message: string, data?: unknown): void {
  winstonLogger[level]({ message, component, ...(data ? { data } : {}) });

  const entry: LogEntry = {
    ts: Date.now(),
    level,
    component,
    message,
    data,
  };

  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();

  // Broadcast to connected WebSocket clients for the Logs panel
  if (broadcastFn && level !== 'debug') {
    broadcastFn({ type: 'log_entry', data: entry, ts: entry.ts });
  }
}

export const logger = {
  debug: (component: string, message: string, data?: unknown) =>
    emit('debug', component, message, data),
  info: (component: string, message: string, data?: unknown) =>
    emit('info', component, message, data),
  warn: (component: string, message: string, data?: unknown) =>
    emit('warn', component, message, data),
  error: (component: string, message: string, data?: unknown) =>
    emit('error', component, message, data),
  getBuffer: (): LogEntry[] => [...logBuffer],
};
