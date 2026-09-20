import {
  CONTRACT_VERSION_V1,
  LocalinkError,
  type CapabilityDescriptor,
  type ModuleManifest,
  type SecretRef,
  type SkillManifest,
} from '@localink/sdk';

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LocalinkError('CONTRACT_INVALID', `${field} is required.`, {
      field,
    });
  }
}

export function assertIdentifier(value: unknown, field: string): void {
  requireString(value, field);
  if (!IDENTIFIER.test(value)) {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      `${field} must be a stable lowercase identifier.`,
      { field },
    );
  }
}

function assertVersion(value: unknown, field: string): void {
  requireString(value, field);
  if (!VERSION.test(value)) {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      `${field} must be a semantic version.`,
      { field },
    );
  }
}

function assertStringArray(value: unknown, field: string): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
  ) {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      `${field} must be an array of strings.`,
      { field },
    );
  }
}

function assertRelativeMetadataPaths(
  value: readonly string[] | undefined,
  field: string,
): void {
  assertStringArray(value, field);
  for (const entry of value ?? []) {
    if (
      entry.length === 0 ||
      entry.startsWith('/') ||
      entry.includes('\0') ||
      entry.split(/[\\/]+/u).includes('..')
    ) {
      throw new LocalinkError(
        'CONTRACT_INVALID',
        `${field} entries must be safe relative paths.`,
        { field },
      );
    }
  }
}

export function validateModuleManifest(manifest: ModuleManifest): void {
  if (manifest === null || typeof manifest !== 'object') {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Module manifest must be an object.',
    );
  }
  if (manifest.contractVersion !== CONTRACT_VERSION_V1) {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Unsupported module contract version.',
    );
  }
  assertIdentifier(manifest.id, 'module.id');
  assertVersion(manifest.version, 'module.version');
  requireString(manifest.title, 'module.title');
  if (
    manifest.runtime === undefined ||
    manifest.runtime === null ||
    typeof manifest.runtime !== 'object' ||
    manifest.runtime.apiVersion !== CONTRACT_VERSION_V1
  ) {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Module runtime apiVersion must match contract V1.',
    );
  }
  assertStringArray(manifest.dependencies, 'module.dependencies');
  assertStringArray(manifest.capabilityIds, 'module.capabilityIds');
  assertStringArray(manifest.publicSemanticIds, 'module.publicSemanticIds');
  if (manifest.authProviderId !== undefined) {
    assertIdentifier(manifest.authProviderId, 'module.authProviderId');
  }
}

export function validateCapabilityDescriptor(
  descriptor: CapabilityDescriptor,
): void {
  if (descriptor === null || typeof descriptor !== 'object') {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Capability descriptor must be an object.',
    );
  }
  if (descriptor.contractVersion !== CONTRACT_VERSION_V1) {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Unsupported capability contract version.',
    );
  }
  assertIdentifier(descriptor.id, 'capability.id');
  assertIdentifier(descriptor.moduleId, 'capability.moduleId');
  assertVersion(descriptor.version, 'capability.version');
  requireString(descriptor.title, 'capability.title');
  requireString(descriptor.description, 'capability.description');
  requireString(descriptor.outputSummary, 'capability.outputSummary');
  if (!['read', 'write'].includes(descriptor.operationClass)) {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Capability operationClass is invalid.',
    );
  }
  if (descriptor.requiredIdentity !== undefined) {
    assertIdentifier(
      descriptor.requiredIdentity,
      'capability.requiredIdentity',
    );
  }
  for (const [field, value] of [
    ['capability.reversible', descriptor.reversible],
    ['capability.supportsPrecondition', descriptor.supportsPrecondition],
    ['capability.publicSemantic', descriptor.publicSemantic],
  ] as const) {
    if (typeof value !== 'boolean') {
      throw new LocalinkError('CONTRACT_INVALID', `${field} must be boolean.`, {
        field,
      });
    }
  }
  if (![0, 1, 2, 3].includes(descriptor.riskTier)) {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Capability riskTier is invalid.',
    );
  }
  if (!['none', 'optional', 'required'].includes(descriptor.postVerify)) {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Capability postVerify requirement is invalid.',
    );
  }
  assertStringArray(descriptor.requiredScopes, 'capability.requiredScopes');
  if (
    descriptor.inputSchema === undefined ||
    descriptor.inputSchema === null ||
    typeof descriptor.inputSchema !== 'object' ||
    !['inline', 'reference'].includes(descriptor.inputSchema.kind)
  ) {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Capability inputSchema is invalid.',
    );
  }
  if (
    descriptor.inputSchema.kind === 'reference' &&
    (typeof descriptor.inputSchema.reference !== 'string' ||
      descriptor.inputSchema.reference.length === 0)
  ) {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Capability schema reference is required.',
    );
  }
  if (
    descriptor.inputSchema.kind === 'inline' &&
    (descriptor.inputSchema.schema === undefined ||
      descriptor.inputSchema.schema === null ||
      typeof descriptor.inputSchema.schema !== 'object')
  ) {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Capability inline schema is required.',
    );
  }
}

export function validateSecretRef(ref: SecretRef, providerId?: string): void {
  if (ref === null || typeof ref !== 'object') {
    throw new LocalinkError('CONTRACT_INVALID', 'SecretRef must be an object.');
  }
  assertIdentifier(ref.provider, 'secretRef.provider');
  requireString(ref.key, 'secretRef.key');
  if (ref.key.includes('\0')) {
    throw new LocalinkError('CONTRACT_INVALID', 'SecretRef key is invalid.');
  }
  if (providerId !== undefined && ref.provider !== providerId) {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'SecretRef provider does not match the selected provider.',
    );
  }
  if (ref.namespace !== undefined) {
    assertIdentifier(ref.namespace, 'secretRef.namespace');
  }
}

export function validateSkillManifest(manifest: SkillManifest): void {
  if (manifest === null || typeof manifest !== 'object') {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Skill manifest must be an object.',
    );
  }
  if (manifest.contractVersion !== CONTRACT_VERSION_V1) {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Unsupported Skill contract version.',
    );
  }
  assertIdentifier(manifest.id, 'skill.id');
  assertVersion(manifest.version, 'skill.version');
  requireString(manifest.title, 'skill.title');
  requireString(manifest.description, 'skill.description');
  if (manifest.entry !== 'SKILL.md') {
    throw new LocalinkError(
      'CONTRACT_INVALID',
      'Skill entry must be SKILL.md for contract V1.',
    );
  }
  assertStringArray(manifest.tags, 'skill.tags');
  assertRelativeMetadataPaths(manifest.assets, 'skill.assets');
  assertRelativeMetadataPaths(manifest.scripts, 'skill.scripts');
}
