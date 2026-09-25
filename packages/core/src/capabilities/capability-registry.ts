import { createHash, randomBytes } from 'node:crypto';
import {
  LocalinkError,
  type CapabilityAvailability,
  type CapabilityDescriptor,
  type CapabilityHandler,
  type CapabilityInvokeContext,
  type CapabilityInvokeReceipt,
} from '@localink/sdk';
import { validateCapabilityDescriptor } from '../contracts/validation.js';
import { PolicyEngine } from '../policy/policy-engine.js';

interface CapabilityEntry {
  descriptor: CapabilityDescriptor;
  handler: CapabilityHandler;
}

export interface CapabilityRegistryOptions {
  readonly policy?: PolicyEngine;
  readonly isModuleEnabled?: (moduleId: string) => boolean;
  readonly confirmationTtlMs?: number;
  readonly now?: () => number;
  readonly ticketFactory?: () => string;
}

interface ConfirmationTicket {
  readonly capabilityId: string;
  readonly inputHash: string;
  readonly riskTier: 2;
  readonly expiresAt: number;
}

const DEFAULT_CONFIRMATION_TTL_MS = 2 * 60 * 1000;
const MAX_CONFIRMATION_TICKETS = 256;

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value))
        throw new LocalinkError(
          'INVALID_ARGUMENT',
          'Capability input is not canonical JSON.',
        );
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (seen.has(value))
        throw new LocalinkError(
          'INVALID_ARGUMENT',
          'Capability input is not canonical JSON.',
        );
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
        }
        const record = value as Record<string, unknown>;
        const prototype = Object.getPrototypeOf(record);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new LocalinkError(
            'INVALID_ARGUMENT',
            'Capability input is not canonical JSON.',
          );
        }
        const entries = Object.keys(record)
          .sort()
          .map((key) => {
            const item = record[key];
            if (item === undefined)
              throw new LocalinkError(
                'INVALID_ARGUMENT',
                'Capability input is not canonical JSON.',
              );
            return `${JSON.stringify(key)}:${canonicalJson(item, seen)}`;
          });
        return `{${entries.join(',')}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Capability input is not canonical JSON.',
      );
  }
}

function inputHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export class CapabilityRegistry {
  readonly #entries = new Map<string, CapabilityEntry>();
  readonly #policy: PolicyEngine;
  readonly #isModuleEnabled: (moduleId: string) => boolean;
  readonly #confirmationTtlMs: number;
  readonly #now: () => number;
  readonly #ticketFactory: () => string;
  readonly #confirmationTickets = new Map<string, ConfirmationTicket>();

  constructor(options: CapabilityRegistryOptions = {}) {
    this.#policy = options.policy ?? new PolicyEngine();
    this.#isModuleEnabled = options.isModuleEnabled ?? (() => true);
    this.#confirmationTtlMs =
      options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#ticketFactory =
      options.ticketFactory ?? (() => randomBytes(32).toString('base64url'));
    if (
      !Number.isSafeInteger(this.#confirmationTtlMs) ||
      this.#confirmationTtlMs <= 0
    ) {
      throw new LocalinkError(
        'CONTRACT_INVALID',
        'Confirmation ticket TTL must be a positive integer.',
      );
    }
  }

  register(
    descriptor: CapabilityDescriptor,
    handler: CapabilityHandler,
  ): CapabilityDescriptor {
    validateCapabilityDescriptor(descriptor);
    if (typeof handler !== 'function') {
      throw new LocalinkError(
        'CONTRACT_INVALID',
        'Capability handler must be a function.',
      );
    }
    if (this.#entries.has(descriptor.id)) {
      throw new LocalinkError(
        'ALREADY_EXISTS',
        'Capability is already registered.',
        { capabilityId: descriptor.id },
      );
    }
    const stored = structuredClone(descriptor);
    this.#entries.set(descriptor.id, { descriptor: stored, handler });
    return structuredClone(stored);
  }

  list(): CapabilityDescriptor[] {
    return [...this.#entries.values()]
      .map((entry) => structuredClone(entry.descriptor))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  search(query = ''): CapabilityDescriptor[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (normalized.length === 0) return this.list();
    return this.list().filter((item) =>
      [item.id, item.title, item.description, item.moduleId].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      ),
    );
  }

  describe(capabilityId: string): CapabilityDescriptor {
    return structuredClone(this.#get(capabilityId).descriptor);
  }

  availability(
    capabilityId: string,
    context: CapabilityInvokeContext,
  ): CapabilityAvailability {
    const descriptor = this.#get(capabilityId).descriptor;
    const reasons: string[] = [];
    if (!this.#isModuleEnabled(descriptor.moduleId)) {
      reasons.push('MODULE_DISABLED');
    }
    if (descriptor.requiredIdentity !== undefined) {
      if (context.identity === undefined) {
        reasons.push('IDENTITY_MISSING');
      } else if (context.identity.type !== descriptor.requiredIdentity) {
        reasons.push('IDENTITY_MISMATCH');
      }
    }
    const granted = new Set(context.grantedScopes ?? []);
    for (const scope of descriptor.requiredScopes) {
      if (!granted.has(scope)) reasons.push(`SCOPE_MISSING:${scope}`);
    }
    return {
      capabilityId,
      available: reasons.length === 0,
      reasons,
    };
  }

  async invoke(
    capabilityId: string,
    input: unknown,
    context: CapabilityInvokeContext,
  ): Promise<CapabilityInvokeReceipt> {
    const entry = this.#get(capabilityId);
    const decision = this.#policy.evaluate(
      entry.descriptor,
      context.policyProfile,
      context.workspacePolicyOverride,
    );

    if (decision.action === 'confirm') {
      return {
        capabilityId,
        status: 'confirmation_required',
        policy: decision,
        ...(entry.descriptor.riskTier === 2
          ? { confirmation: this.#issueConfirmation(capabilityId, input) }
          : {}),
      };
    }
    if (decision.action === 'deny') {
      return { capabilityId, status: 'denied', policy: decision };
    }

    const availability = this.availability(capabilityId, context);
    if (!availability.available) {
      if (availability.reasons.includes('IDENTITY_MISSING')) {
        throw new LocalinkError(
          'IDENTITY_REQUIRED',
          'Capability requires an explicit identity.',
          { capabilityId },
        );
      }
      if (availability.reasons.includes('IDENTITY_MISMATCH')) {
        throw new LocalinkError(
          'IDENTITY_REQUIRED',
          'Capability identity does not match the required identity.',
          { capabilityId, requiredIdentity: entry.descriptor.requiredIdentity },
        );
      }
      const missingScopes = availability.reasons
        .filter((reason) => reason.startsWith('SCOPE_MISSING:'))
        .map((reason) => reason.slice('SCOPE_MISSING:'.length));
      if (missingScopes.length > 0) {
        throw new LocalinkError(
          'SCOPE_REQUIRED',
          'Capability is missing required scopes.',
          { capabilityId, missingScopes },
        );
      }
      throw new LocalinkError(
        'CAPABILITY_UNAVAILABLE',
        'Capability is not currently available.',
        { capabilityId, reasons: availability.reasons },
      );
    }

    return this.#execute(entry, capabilityId, input, context, decision);
  }

  async invokeConfirmed(
    ticket: string,
    capabilityId: string,
    input: unknown,
    context: CapabilityInvokeContext,
  ): Promise<CapabilityInvokeReceipt> {
    if (
      context.policyProfile !== 'balanced' ||
      context.workspacePolicyOverride !== undefined
    ) {
      throw new LocalinkError(
        'POLICY_DENIED',
        'Confirmed invocation requires the balanced production policy.',
        { capabilityId },
      );
    }
    if (
      typeof ticket !== 'string' ||
      ticket.length < 32 ||
      ticket.length > 128
    ) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Confirmation ticket is invalid.',
      );
    }
    const pending = this.#confirmationTickets.get(ticket);
    if (pending === undefined) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Confirmation ticket is invalid, expired, or already used.',
      );
    }
    // A presented ticket is single-use even when the caller supplies a
    // mismatched capability or input. This prevents confirmation probing.
    this.#confirmationTickets.delete(ticket);
    const now = this.#now();
    if (pending.expiresAt <= now) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Confirmation ticket expired.',
      );
    }
    if (
      pending.capabilityId !== capabilityId ||
      pending.riskTier !== 2 ||
      pending.inputHash !== inputHash(input)
    ) {
      throw new LocalinkError(
        'INVALID_ARGUMENT',
        'Confirmation ticket does not match the requested invocation.',
      );
    }
    const entry = this.#get(capabilityId);
    if (entry.descriptor.riskTier !== 2) {
      throw new LocalinkError(
        'POLICY_DENIED',
        'Only Tier 2 capabilities can use confirmed invocation.',
        { capabilityId },
      );
    }
    const availability = this.availability(capabilityId, context);
    if (!availability.available) {
      throw new LocalinkError(
        'CAPABILITY_UNAVAILABLE',
        'Capability is not currently available.',
        { capabilityId, reasons: availability.reasons },
      );
    }
    return this.#execute(entry, capabilityId, input, context, {
      action: 'allow',
      profile: 'balanced',
      tier: 2,
      reason: {
        code: 'POLICY_BALANCED_TIER_2_CONFIRMED',
        message: 'A matching single-use confirmation ticket was consumed.',
      },
      workspaceOverrideApplied: false,
    });
  }

  async #execute(
    entry: CapabilityEntry,
    capabilityId: string,
    input: unknown,
    context: CapabilityInvokeContext,
    decision: CapabilityInvokeReceipt['policy'],
  ): Promise<CapabilityInvokeReceipt> {
    let result;
    try {
      result = await entry.handler(input, context);
    } catch {
      throw new LocalinkError(
        'CAPABILITY_UNAVAILABLE',
        'Capability handler failed.',
        { capabilityId },
      );
    }
    if (
      entry.descriptor.postVerify === 'required' &&
      result.verification?.verified !== true
    ) {
      throw new LocalinkError(
        'VERIFICATION_REQUIRED',
        'Capability requires a successful post-write verification receipt.',
        { capabilityId },
      );
    }
    return {
      capabilityId,
      status: 'executed',
      policy: decision,
      output: result.output,
      ...(result.verification === undefined
        ? {}
        : { verification: result.verification }),
    };
  }

  #issueConfirmation(
    capabilityId: string,
    input: unknown,
  ): NonNullable<CapabilityInvokeReceipt['confirmation']> {
    const now = this.#now();
    for (const [ticket, pending] of this.#confirmationTickets) {
      if (pending.expiresAt <= now) this.#confirmationTickets.delete(ticket);
    }
    if (this.#confirmationTickets.size >= MAX_CONFIRMATION_TICKETS) {
      const oldest = this.#confirmationTickets.keys().next().value as
        string | undefined;
      if (oldest !== undefined) this.#confirmationTickets.delete(oldest);
    }
    let ticket = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      ticket = this.#ticketFactory();
      if (
        typeof ticket === 'string' &&
        ticket.length >= 32 &&
        ticket.length <= 128 &&
        !this.#confirmationTickets.has(ticket)
      ) {
        break;
      }
      ticket = '';
    }
    if (ticket.length === 0) {
      throw new LocalinkError(
        'CAPABILITY_UNAVAILABLE',
        'A confirmation ticket could not be created.',
      );
    }
    const expiresAt = now + this.#confirmationTtlMs;
    this.#confirmationTickets.set(ticket, {
      capabilityId,
      inputHash: inputHash(input),
      riskTier: 2,
      expiresAt,
    });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  #get(capabilityId: string): CapabilityEntry {
    const entry = this.#entries.get(capabilityId);
    if (entry === undefined) {
      throw new LocalinkError(
        'CAPABILITY_NOT_FOUND',
        'Capability was not found.',
        { capabilityId },
      );
    }
    return entry;
  }
}
