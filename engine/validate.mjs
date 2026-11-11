/** Tiny JSON-Schema subset validator — enough for interaction answers. */
export function validate(schema, value, path = '$') {
  const errors = [];
  const fail = (msg) => errors.push(`${path}: ${msg}`);
  if (!schema || typeof schema !== 'object') return { ok: true, errors };

  const type = schema.type;
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (type && type !== actual) { fail(`expected ${type}, got ${actual}`); return { ok: false, errors }; }

  if (schema.enum && !schema.enum.includes(value)) fail(`not in enum (${JSON.stringify(value)})`);

  if (actual === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) fail(`shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) fail(`longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`does not match ${schema.pattern}`);
  }
  if (actual === 'number') {
    if (schema.minimum != null && value < schema.minimum) fail(`< ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) fail(`> ${schema.maximum}`);
  }
  if (actual === 'array') {
    if (schema.minItems != null && value.length < schema.minItems) fail(`fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) fail(`more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => {
      const r = validate(schema.items, v, `${path}[${i}]`);
      if (!r.ok) errors.push(...r.errors);
    });
  }
  if (actual === 'object') {
    for (const k of schema.required || []) if (value[k] === undefined) fail(`missing required "${k}"`);
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) {
        const r = validate(props[k], v, `${path}.${k}`);
        if (!r.ok) errors.push(...r.errors);
      } else if (schema.additionalProperties === false) {
        fail(`unexpected property "${k}"`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
