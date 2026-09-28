import { AgentError } from './types.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringList(value: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    return undefined;
  }
  return value;
}

function allowedStringValues(
  schema: Record<string, unknown>,
): readonly string[] | undefined {
  const direct = stringList(schema.enum);
  if (direct) return direct;
  const choices = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (!choices) return undefined;
  const values: string[] = [];
  for (const choice of choices) {
    const option = record(choice);
    if (!option || typeof option.const !== 'string') return undefined;
    values.push(option.const);
  }
  return values;
}

function validatePrimitive(
  schemaValue: unknown,
  value: unknown,
  field: string,
): void {
  const schema = record(schemaValue);
  if (!schema) {
    throw new AgentError(
      'AGENT_INTERACTION_SCHEMA_UNSUPPORTED',
      `Unsupported MCP form schema for field ${field}.`,
    );
  }
  const type = schema.type;
  const allowed = allowedStringValues(schema);

  if (type === 'string') {
    if (typeof value !== 'string') {
      throw new AgentError(
        'AGENT_INTERACTION_CONTENT_INVALID',
        `Field ${field} must be a string.`,
      );
    }
    if (allowed && !allowed.includes(value)) {
      throw new AgentError(
        'AGENT_INTERACTION_CONTENT_INVALID',
        `Field ${field} is outside the allowed values.`,
      );
    }
    if (
      typeof schema.minLength === 'number' &&
      value.length < schema.minLength
    ) {
      throw new AgentError(
        'AGENT_INTERACTION_CONTENT_INVALID',
        `Field ${field} is shorter than allowed.`,
      );
    }
    if (
      typeof schema.maxLength === 'number' &&
      value.length > schema.maxLength
    ) {
      throw new AgentError(
        'AGENT_INTERACTION_CONTENT_INVALID',
        `Field ${field} is longer than allowed.`,
      );
    }
    return;
  }

  if (type === 'number' || type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (type === 'integer' && !Number.isInteger(value))
    ) {
      throw new AgentError(
        'AGENT_INTERACTION_CONTENT_INVALID',
        `Field ${field} must be a valid ${type}.`,
      );
    }
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      throw new AgentError(
        'AGENT_INTERACTION_CONTENT_INVALID',
        `Field ${field} is below the allowed minimum.`,
      );
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      throw new AgentError(
        'AGENT_INTERACTION_CONTENT_INVALID',
        `Field ${field} is above the allowed maximum.`,
      );
    }
    return;
  }

  if (type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new AgentError(
        'AGENT_INTERACTION_CONTENT_INVALID',
        `Field ${field} must be boolean.`,
      );
    }
    return;
  }

  if (type === 'array') {
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === 'string')
    ) {
      throw new AgentError(
        'AGENT_INTERACTION_CONTENT_INVALID',
        `Field ${field} must be a string array.`,
      );
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      throw new AgentError(
        'AGENT_INTERACTION_CONTENT_INVALID',
        `Field ${field} has too few items.`,
      );
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      throw new AgentError(
        'AGENT_INTERACTION_CONTENT_INVALID',
        `Field ${field} has too many items.`,
      );
    }
    const items = record(schema.items);
    const itemAllowed = items ? allowedStringValues(items) : undefined;
    if (!items || (!itemAllowed && items.type !== 'string')) {
      throw new AgentError(
        'AGENT_INTERACTION_SCHEMA_UNSUPPORTED',
        `Unsupported MCP array schema for field ${field}.`,
      );
    }
    if (itemAllowed && value.some((item) => !itemAllowed.includes(item))) {
      throw new AgentError(
        'AGENT_INTERACTION_CONTENT_INVALID',
        `Field ${field} contains a disallowed value.`,
      );
    }
    return;
  }

  throw new AgentError(
    'AGENT_INTERACTION_SCHEMA_UNSUPPORTED',
    `Unsupported MCP form field type for ${field}.`,
  );
}

export function validateMcpFormContent(
  schemaValue: unknown,
  content: Record<string, unknown>,
): void {
  const schema = record(schemaValue);
  const properties = schema ? record(schema.properties) : undefined;
  if (!schema || schema.type !== 'object' || !properties) {
    throw new AgentError(
      'AGENT_INTERACTION_SCHEMA_UNSUPPORTED',
      'Unsupported MCP form schema.',
    );
  }
  const required =
    schema.required === undefined ? [] : stringList(schema.required);
  if (!required) {
    throw new AgentError(
      'AGENT_INTERACTION_SCHEMA_UNSUPPORTED',
      'Unsupported MCP form required schema.',
    );
  }
  for (const key of Object.keys(content)) {
    if (!(key in properties)) {
      throw new AgentError(
        'AGENT_INTERACTION_CONTENT_INVALID',
        `Unexpected MCP form field: ${key}.`,
      );
    }
  }
  for (const key of required) {
    if (!(key in content)) {
      throw new AgentError(
        'AGENT_INTERACTION_CONTENT_INVALID',
        `Missing required MCP form field: ${key}.`,
      );
    }
  }
  for (const [key, value] of Object.entries(content)) {
    validatePrimitive(properties[key], value, key);
  }
}

export function boundedSchema(
  schemaValue: unknown,
  maxBytes = 8 * 1024,
): Record<string, unknown> | undefined {
  const schema = record(schemaValue);
  if (!schema) return undefined;
  try {
    if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > maxBytes)
      return undefined;
  } catch {
    return undefined;
  }
  return schema;
}
