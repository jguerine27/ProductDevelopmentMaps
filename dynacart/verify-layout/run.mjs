/**
 * Copies the layout modules to .mjs siblings so Node can load them as ESM
 * (dynacart is a CommonJS package, so a .js file cannot use import syntax under
 * plain Node), then runs the harness. Copying at run time means the harness can
 * never drift from the source it is verifying.
 */
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'src', 'Components', 'GraphVisualization');

copyFileSync(join(source, 'graphLayout.js'), join(here, 'graphLayout.mjs'));

const collide = readFileSync(join(source, 'forceRectCollide.js'), 'utf8')
    .replace("from './graphLayout'", "from './graphLayout.mjs'");
writeFileSync(join(here, 'forceRectCollide.mjs'), collide, 'utf8');

copyFileSync(join(source, 'forceAngularLink.js'), join(here, 'forceAngularLink.mjs'));

let failures = 1;
try {
    const { default: verify } = await import('./harness.mjs');
    failures = await verify();
} finally {
    // The copies exist only for the duration of the run; leaving them behind
    // would be a second, silently drifting copy of the layout rules.
    for (const name of ['graphLayout.mjs', 'forceRectCollide.mjs', 'forceAngularLink.mjs']) {
        try { rmSync(join(here, name)); } catch (ignored) { /* already gone */ }
    }
}

process.exit(failures === 0 ? 0 : 1);
