/**
 * The simulated charge point — a state machine that behaves like real EVSE hardware.
 *
 * From the gateway's side this is indistinguishable from a physical charger: it opens the
 * WebSocket outward, authenticates with HTTP Basic on the upgrade, announces itself with a
 * BootNotification, beats periodically, reports connector status, and obeys remote commands.
 *
 * Lifecycle:
 *
 *   connect ──▶ BootNotification ──▶ StatusNotification(Available) ──▶ Heartbeat loop
 *                                                 │
 *                              RemoteStartTransaction received
 *                                                 ▼
 *          Preparing ──▶ Authorize ──▶ StartTransaction ──▶ Charging ──▶ MeterValues…
 *                                                 │
 *                              RemoteStopTransaction received
 *                                                 ▼
 *                    Finishing ──▶ StopTransaction ──▶ Available
 */

import WebSocket from 'ws';

import { config } from './config';
import {
  buildCall,
  buildCallError,
  buildCallResult,
  CALL,
  CALLERROR,
  CALLRESULT,
  newUniqueId,
  parse,
  type Payload,
} from './messages';

type ConnectorStatus = 'Available' | 'Preparing' | 'Charging' | 'Finishing' | 'Faulted' | 'Unavailable';

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [SIM ${config.ocppId}] ${message}`);
}

interface PendingCall {
  resolve: (payload: Payload) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class SimulatedCharger {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingCall>();

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private meterTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private powerKw = config.fallbackPowerKw;
  private heartbeatIntervalSeconds = 30;

  private status: ConnectorStatus = 'Available';
  private transactionId: number | null = null;
  private energyWh = 0;
  private stopping = false;

  /* ------------------------------------------------------------- connect -- */

  start(): void {
    this.connect();
  }

  private connect(): void {
    const url = `${config.gatewayUrl}/${encodeURIComponent(config.ocppId)}`;

    // Identity in the path, credentials in HTTP Basic on the upgrade — the same shape real
    // OCPP 1.6J charge points use.
    const credentials = Buffer.from(`${config.ocppId}:${config.authToken}`).toString('base64');

    log(`connecting to ${url}`);

    const socket = new WebSocket(url, { headers: { Authorization: `Basic ${credentials}` } });
    this.socket = socket;

    socket.on('open', () => {
      log('connected');
      void this.onOpen();
    });

    socket.on('message', (data) => this.onMessage(data.toString()));

    socket.on('close', (code, reason) => {
      log(`disconnected (code ${code}${reason.length ? `, ${reason.toString()}` : ''})`);
      this.cleanupTimers();
      this.failPending('connection closed');
      if (!this.stopping) this.scheduleReconnect();
    });

    socket.on('error', (error) => {
      // A 401 from the gateway surfaces here as an "Unexpected server response" error.
      log(`socket error: ${error.message}`);
      if (error.message.includes('401')) {
        log('authentication rejected — check the charger id and token');
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    log(`reconnecting in ${config.reconnectDelaySeconds}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, config.reconnectDelaySeconds * 1000);
  }

  /* ------------------------------------------------------- boot sequence -- */

  private async onOpen(): Promise<void> {
    try {
      const boot = await this.call('BootNotification', {
        chargePointVendor: 'EV-CMS Simulator',
        chargePointModel: 'SIM-1',
        firmwareVersion: '1.0.0',
      });

      if (boot.status !== 'Accepted') {
        log(`BootNotification rejected: ${String(boot.status)}`);
        return;
      }

      // The backend tells us how often to beat and what this charger's power rating is, so
      // the simulator holds no duplicate configuration.
      if (typeof boot.interval === 'number' && boot.interval > 0) {
        this.heartbeatIntervalSeconds = boot.interval;
      }
      if (typeof boot.powerKw === 'number' && boot.powerKw > 0) {
        this.powerKw = boot.powerKw;
      }

      log(`BootNotification accepted (heartbeat ${this.heartbeatIntervalSeconds}s, ${this.powerKw} kW)`);

      await this.sendStatus('Available');
      this.startHeartbeat();
    } catch (error) {
      log(`boot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private startHeartbeat(): void {
    this.cleanupTimer('heartbeatTimer');
    this.heartbeatTimer = setInterval(() => {
      void this.call('Heartbeat', {})
        .then(() => log('Heartbeat'))
        .catch((error: unknown) =>
          log(`Heartbeat failed: ${error instanceof Error ? error.message : String(error)}`),
        );
    }, this.heartbeatIntervalSeconds * 1000);
  }

  /* --------------------------------------------------------- inbound msg -- */

  private onMessage(raw: string): void {
    const message = parse(raw);

    if (!message) {
      log('received an unparseable frame');
      return;
    }

    if (message.type === CALLRESULT || message.type === CALLERROR) {
      const call = this.pending.get(message.uniqueId);
      if (!call) return;
      clearTimeout(call.timer);
      this.pending.delete(message.uniqueId);

      if (message.type === CALLERROR) {
        call.reject(new Error(`${message.errorCode}: ${message.errorDescription}`));
      } else {
        call.resolve(message.payload);
      }
      return;
    }

    // A command from the backend.
    if (message.type === CALL) {
      void this.onCommand(message.uniqueId, message.action, message.payload);
    }
  }

  private async onCommand(uniqueId: string, action: string, payload: Payload): Promise<void> {
    log(`${action} received`);

    if (action === 'RemoteStartTransaction') {
      if (this.transactionId !== null) {
        this.send(buildCallResult(uniqueId, { status: 'Rejected' }));
        return;
      }
      // Acknowledge FIRST, then act — real chargers reply immediately and begin the
      // transaction asynchronously.
      this.send(buildCallResult(uniqueId, { status: 'Accepted' }));
      await this.beginTransaction(
        typeof payload.connectorId === 'number' ? payload.connectorId : config.connectorNumber,
        typeof payload.idTag === 'string' ? payload.idTag : 'SIMTAG-0001',
      );
      return;
    }

    if (action === 'RemoteStopTransaction') {
      if (this.transactionId === null) {
        this.send(buildCallResult(uniqueId, { status: 'Rejected' }));
        return;
      }
      this.send(buildCallResult(uniqueId, { status: 'Accepted' }));
      await this.endTransaction('Remote');
      return;
    }

    this.send(buildCallError(uniqueId, 'NotSupported', `Action "${action}" is not supported`));
  }

  /* -------------------------------------------------------- transactions -- */

  private async beginTransaction(connectorNumber: number, idTag: string): Promise<void> {
    try {
      await this.sendStatus('Preparing');

      // Ask whether this credential may draw power. Real hardware asks before delivering.
      const auth = await this.call('Authorize', { idTag });
      const authStatus = (auth.idTagInfo as Payload | undefined)?.status;

      if (authStatus !== 'Accepted') {
        log(`Authorize rejected (${String(authStatus)}) — aborting`);
        await this.sendStatus('Available');
        return;
      }

      log('Authorize accepted');

      this.energyWh = 0;

      const start = await this.call('StartTransaction', {
        connectorId: connectorNumber,
        idTag,
        meterStart: this.energyWh,
        timestamp: new Date().toISOString(),
      });

      this.transactionId = typeof start.transactionId === 'number' ? start.transactionId : null;
      log(`StartTransaction accepted (transaction ${this.transactionId})`);

      await this.sendStatus('Charging');
      this.startMetering();
    } catch (error) {
      log(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
      await this.sendStatus('Available').catch(() => undefined);
    }
  }

  /**
   * Energy accrues deterministically from the charger's real power rating:
   *
   *   energyWh += powerKw × 1000 × (intervalSeconds / 3600)
   *
   * At 60 kW on a 5-second tick that is exactly 83.33 Wh per reading — monotonic and
   * reproducible, so a test can assert it strictly increases rather than hoping a random
   * walk behaves.
   */
  private startMetering(): void {
    this.cleanupTimer('meterTimer');

    const perTickWh = (this.powerKw * 1000 * config.meterIntervalSeconds) / 3600;

    this.meterTimer = setInterval(() => {
      this.energyWh += perTickWh;

      void this.call('MeterValues', {
        connectorId: config.connectorNumber,
        transactionId: this.transactionId,
        energyWh: Number(this.energyWh.toFixed(2)),
        timestamp: new Date().toISOString(),
      })
        .then(() => log(`MeterValues ${(this.energyWh / 1000).toFixed(3)} kWh`))
        .catch((error: unknown) =>
          log(`MeterValues failed: ${error instanceof Error ? error.message : String(error)}`),
        );
    }, config.meterIntervalSeconds * 1000);
  }

  private async endTransaction(reason: string): Promise<void> {
    this.cleanupTimer('meterTimer');

    try {
      await this.sendStatus('Finishing');

      await this.call('StopTransaction', {
        transactionId: this.transactionId,
        meterStop: Number(this.energyWh.toFixed(2)),
        reason,
        timestamp: new Date().toISOString(),
      });

      log(`StopTransaction sent (${(this.energyWh / 1000).toFixed(3)} kWh total)`);
    } catch (error) {
      log(`failed to stop cleanly: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.transactionId = null;
      await this.sendStatus('Available').catch(() => undefined);
    }
  }

  /* -------------------------------------------------------------- plumbing */

  /**
   * `connectorId` defaults to this simulator's plug. Passing 0 addresses the CHARGE POINT
   * ITSELF, which in OCPP 1.6 is how a machine reports something true of the whole box rather
   * than of any one socket — and is a different message to the backend, not a variant of this
   * one.
   */
  private async sendStatus(
    status: ConnectorStatus,
    options: { connectorId?: number; errorCode?: string } = {},
  ): Promise<void> {
    const connectorId = options.connectorId ?? config.connectorNumber;

    // Only a message about THIS plug describes this plug. A charge-point-level message must
    // not overwrite the connector state the simulator is tracking.
    if (connectorId === config.connectorNumber) this.status = status;

    await this.call('StatusNotification', {
      connectorId,
      status,
      errorCode: options.errorCode ?? (status === 'Faulted' ? 'OtherError' : 'NoError'),
      timestamp: new Date().toISOString(),
    });

    log(`StatusNotification: ${status}${connectorId === 0 ? ' (charge point)' : ''}`);
  }

  /* ------------------------------------------------------------- faults -- */

  /**
   * THE PLUG BREAKS, THE MACHINE IS FINE.
   *
   * Note what this deliberately does NOT send: a StopTransaction. Hardware whose connector has
   * just failed cannot always close its transaction cleanly — that is precisely why the
   * backend has to end the session from the fault itself, and simulating a polite shutdown
   * here would demonstrate a case that is never the problem.
   */
  async faultConnector(errorCode = 'ConnectorLockFailure'): Promise<void> {
    this.cleanupTimer('meterTimer');
    this.transactionId = null;

    log(`raising a CONNECTOR fault (${errorCode}) on connector ${config.connectorNumber}`);
    await this.sendStatus('Faulted', { errorCode });
  }

  /**
   * THE MACHINE BREAKS, THE PLUGS ARE FINE.
   *
   * connectorId 0, and the reason this method exists: every connector still reports
   * `Available`, so nothing about the plugs says anything is wrong. A CPMS that only listens
   * per connector hears silence here and keeps sending drivers to a dead charger.
   */
  async faultChargePoint(errorCode = 'GroundFailure'): Promise<void> {
    this.cleanupTimer('meterTimer');
    this.transactionId = null;

    log(`raising a CHARGE POINT fault (${errorCode}) — connectorId 0, plugs untouched`);
    await this.sendStatus('Faulted', { connectorId: 0, errorCode });
  }

  /** The engineer has been and gone: report healthy at both levels. */
  async clearFaults(): Promise<void> {
    log('clearing faults at both levels');
    await this.sendStatus('Available', { connectorId: 0 });
    await this.sendStatus('Available');
  }

  private call(action: string, payload: Payload): Promise<Payload> {
    const uniqueId = newUniqueId();

    return new Promise<Payload>((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('socket is not open'));
        return;
      }

      const timer = setTimeout(() => {
        this.pending.delete(uniqueId);
        reject(new Error(`no response to ${action}`));
      }, 10_000);
      timer.unref();

      this.pending.set(uniqueId, { resolve, reject, timer });
      this.socket.send(buildCall(uniqueId, action, payload));
    });
  }

  private send(frame: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame);
  }

  private failPending(reason: string): void {
    for (const [uniqueId, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new Error(reason));
      this.pending.delete(uniqueId);
    }
  }

  private cleanupTimer(name: 'heartbeatTimer' | 'meterTimer' | 'reconnectTimer'): void {
    const timer = this[name];
    if (timer) {
      clearInterval(timer);
      clearTimeout(timer);
      this[name] = null;
    }
  }

  private cleanupTimers(): void {
    this.cleanupTimer('heartbeatTimer');
    this.cleanupTimer('meterTimer');
  }

  /** Current state, for the startup banner and tests. */
  get currentStatus(): ConnectorStatus {
    return this.status;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.cleanupTimer('reconnectTimer');

    if (this.transactionId !== null) {
      log('stopping an in-flight transaction before exit');
      await this.endTransaction('SoftReset').catch(() => undefined);
    }

    this.cleanupTimers();
    this.failPending('shutting down');
    this.socket?.close(1000, 'Simulator shutting down');
  }
}
