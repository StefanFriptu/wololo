export type JsonSchema = { [key: string]: unknown };

export interface TypeExpressionSchema {
  schema: JsonSchema;
  /** Named types referenced as #/components/schemas/<name>. */
  refs: string[];
}

const PRIMITIVES: Readonly<Record<string, JsonSchema>> = {
  string: { type: 'string' },
  number: { type: 'number' },
  boolean: { type: 'boolean' },
  null: { type: 'null' },
  unknown: {},
  Blob: { type: 'string', contentMediaType: 'application/octet-stream' },
};

const TOKEN_PATTERN = /\s*([A-Za-z_][A-Za-z0-9_]*|[<>,|[\]])/y;

function tokenize(expression: string): string[] {
  const tokens: string[] = [];
  TOKEN_PATTERN.lastIndex = 0;
  while (TOKEN_PATTERN.lastIndex < expression.trimEnd().length) {
    const start = TOKEN_PATTERN.lastIndex;
    const match = TOKEN_PATTERN.exec(expression);
    if (!match?.[1]) throw new Error(`unexpected character at ${start} in type expression "${expression}"`);
    tokens.push(match[1]);
  }
  return tokens;
}

function genericSchema(name: string, args: JsonSchema[], expression: string): JsonSchema {
  const [first, second] = args;
  if ((name === 'Array' || name === 'ReadonlyArray') && args.length === 1) return { type: 'array', items: first };
  if (name === 'Record' && args.length === 2) return { type: 'object', additionalProperties: second };
  if (name === 'Paginated' && args.length === 1) {
    return {
      type: 'object',
      required: ['page', 'pageSize', 'total', 'items'],
      properties: {
        page: { type: 'integer', minimum: 1 },
        pageSize: { type: 'integer', minimum: 1 },
        total: { type: 'integer', minimum: 0 },
        items: { type: 'array', items: first },
      },
    };
  }
  throw new Error(`unsupported generic ${name}<${args.length} args> in type expression "${expression}"`);
}

/**
 * Pure: turns a TypeScript type expression from ApiRoutes ("HealthCheck[]", "Paginated<JobSummary>", "ScanStatus | null",
 * "Record<string, unknown>") into a JSON Schema whose named types are $refs to components.
 */
export function typeExpressionSchema(expression: string): TypeExpressionSchema {
  const tokens = tokenize(expression);
  const refs = new Set<string>();
  let position = 0;

  const peek = () => tokens[position];
  const take = (expected?: string): string => {
    const token = tokens[position];
    if (token === undefined || (expected !== undefined && token !== expected))
      throw new Error(`expected ${expected ?? 'a type'} at token ${position} in type expression "${expression}"`);
    position += 1;
    return token;
  };

  const parseTerm = (): JsonSchema => {
    const name = take();
    if (!/^[A-Za-z_]/.test(name)) throw new Error(`expected a type name, got "${name}" in "${expression}"`);
    if (peek() === '<') {
      take('<');
      const args = [parseUnion()];
      while (peek() === ',') {
        take(',');
        args.push(parseUnion());
      }
      take('>');
      return genericSchema(name, args, expression);
    }
    const primitive = PRIMITIVES[name];
    if (primitive) return { ...primitive };
    refs.add(name);
    return { $ref: `#/components/schemas/${name}` };
  };

  const parseArray = (): JsonSchema => {
    let schema = parseTerm();
    while (peek() === '[') {
      take('[');
      take(']');
      schema = { type: 'array', items: schema };
    }
    return schema;
  };

  const parseUnion = (): JsonSchema => {
    const members = [parseArray()];
    while (peek() === '|') {
      take('|');
      members.push(parseArray());
    }
    return members.length === 1 ? (members[0] as JsonSchema) : { anyOf: members };
  };

  const schema = parseUnion();
  if (position !== tokens.length) throw new Error(`unexpected "${peek()}" in type expression "${expression}"`);
  return { schema, refs: [...refs].sort() };
}
