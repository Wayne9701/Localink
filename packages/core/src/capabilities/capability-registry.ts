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
}

export class CapabilityRegistry {
  readonly #entries = new Map<string, CapabilityEntry>();
  readonly #policy: PolicyEngine;
  readonly #isModuleEnabled: (moduleId: string) => boolean;

  constructor(options: CapabilityRegistryOptions = {}) {
    this.#policy = options.policy ?? new PolicyEngine();
    this.#isModuleEnabled = options.isModuleEnabled ?? (() => true);
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
