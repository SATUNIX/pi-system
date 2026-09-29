/**
 * Dependency-free JSON Schema validator for the role result schemas.
 *
 * Supports the keyword subset the role schemas use: type (including union with
 * "null"), const, enum, required, properties, additionalProperties (boolean),
 * items, minItems, maxItems, minLength, maxLength, minimum, maximum and
 * pattern. It fails closed: an unsupported keyword present in a schema makes
 * validation fail rather than silently pass.
 */

export type JsonSchema = Record<string, unknown>;

const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "pattern",
]);

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  if (expected === "integer") return actual === "integer";
  return actual === expected;
}

function pointer(path: string, key: string | number): string {
  return `${path}/${String(key)}`;
}

function check(schema: unknown, value: unknown, path: string, errors: string[]): void {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    errors.push(`${path}: schema is false`);
    return;
  }
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    errors.push(`${path}: schema node must be an object`);
    return;
  }
  const node = schema as JsonSchema;
  for (const keyword of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      errors.push(`${path}: unsupported schema keyword "${keyword}"`);
      return;
    }
  }

  if ("const" in node && JSON.stringify(node.const) !== JSON.stringify(value)) {
    errors.push(`${path}: must equal ${JSON.stringify(node.const)}`);
  }
  if (Array.isArray(node.enum) && !node.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(node.enum)}`);
  }
  if ("type" in node) {
    const expected = Array.isArray(node.type) ? node.type : [node.type];
    if (!expected.some((candidate) => typeof candidate === "string" && matchesType(value, candidate))) {
      errors.push(`${path}: expected type ${JSON.stringify(node.type)}, got ${typeOf(value)}`);
      return;
    }
  }

  if (typeof value === "string") {
    if (typeof node.minLength === "number" && value.length < node.minLength) {
      errors.push(`${path}: shorter than minLength ${node.minLength}`);
    }
    if (typeof node.maxLength === "number" && value.length > node.maxLength) {
      errors.push(`${path}: longer than maxLength ${node.maxLength}`);
    }
    if (typeof node.pattern === "string" && !new RegExp(node.pattern).test(value)) {
      errors.push(`${path}: does not match pattern ${node.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) {
      errors.push(`${path}: below minimum ${node.minimum}`);
    }
    if (typeof node.maximum === "number" && value > node.maximum) {
      errors.push(`${path}: above maximum ${node.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) {
      errors.push(`${path}: fewer than minItems ${node.minItems}`);
    }
    if (typeof node.maxItems === "number" && value.length > node.maxItems) {
      errors.push(`${path}: more than maxItems ${node.maxItems}`);
    }
    if (node.items !== undefined) {
      value.forEach((item, index) => check(node.items, item, pointer(path, index), errors));
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(node.required)) {
      for (const key of node.required) {
        if (typeof key === "string" && !(key in record)) {
          errors.push(`${path}: missing required property "${key}"`);
        }
      }
    }
    const properties = node.properties;
    if (properties !== undefined && typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
      for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
        if (key in record) check(child, record[key], pointer(path, key), errors);
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!(key in (properties as Record<string, unknown>))) {
            errors.push(`${path}: additional property "${key}" is not allowed`);
          }
        }
      } else if (node.additionalProperties !== undefined && node.additionalProperties !== true) {
        for (const key of Object.keys(record)) {
          if (!(key in (properties as Record<string, unknown>))) {
            check(node.additionalProperties, record[key], pointer(path, key), errors);
          }
        }
      }
    } else if (node.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        errors.push(`${path}: additional property "${key}" is not allowed`);
      }
    }
  }
}

export function validateSchema(schema: unknown, value: unknown): string[] {
  const errors: string[] = [];
  check(schema, value, "$", errors);
  return errors;
}
