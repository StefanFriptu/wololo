/**
 * Partial service fakes for createTestContext({ overrides }). Unimplemented methods throw a clear error when called,
 * so a test fails loudly instead of silently hitting another module's real implementation.
 */
export function stubService<T extends object>(name: string, implemented: Partial<T> = {}): T {
  return new Proxy(implemented, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver);
      if (typeof property === 'symbol' || property === 'then') return undefined;
      return () => {
        throw new Error(`${name}.${property} is not stubbed in this test`);
      };
    },
  }) as T;
}
