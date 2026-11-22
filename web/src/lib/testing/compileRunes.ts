import { compileModule } from 'svelte/compiler';

const SVELTE_CLIENT = Bun.resolveSync('svelte/internal/client', import.meta.dir).replace(
  /internal\/client\/index\.js$/,
  'index-client.js',
);

const SVELTE_REACTIVITY_CLIENT = Bun.resolveSync('svelte/reactivity', import.meta.dir).replace(
  /index-server\.js$/,
  'index-client.js',
);

let registered = false;

/**
 * Lets bun tests import `.svelte.ts` rune modules, compiled for the browser runtime. Rune modules must be imported
 * dynamically after this call: static imports are loaded before any test code runs.
 */
export function compileRunes(): void {
  if (registered) return;
  registered = true;
  const transpiler = new Bun.Transpiler({ loader: 'ts', deadCodeElimination: false });
  Bun.plugin({
    name: 'svelte-runes',
    setup(build) {
      build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
        const js = transpiler.transformSync(await Bun.file(path).text());
        const { code } = compileModule(js, { generate: 'client', filename: path }).js;
        const contents = code
          .replaceAll(/from ['"]svelte['"]/g, `from '${SVELTE_CLIENT}'`)
          .replaceAll(/from ['"]svelte\/reactivity['"]/g, `from '${SVELTE_REACTIVITY_CLIENT}'`);
        return { contents, loader: 'js' };
      });
    },
  });
}
