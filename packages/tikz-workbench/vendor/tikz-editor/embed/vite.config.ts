import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
	plugins: [react()],
	base: './',
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		target: 'es2022',
	},
	resolve: {
		alias: [
			{ find: /^@tikz-editor\/app$/, replacement: path.resolve(__dirname, '../../packages/app/src/index.ts') },
			{ find: /^@tikz-editor\/app\/store$/, replacement: path.resolve(__dirname, '../../packages/app/src/store/store.ts') },
			{ find: /^@tikz-editor\/app\/app-menu$/, replacement: path.resolve(__dirname, '../../packages/app/src/app-menu/index.ts') },
			{ find: /^@tikz-editor\/app\/linked-file-sync$/, replacement: path.resolve(__dirname, '../../packages/app/src/linked-file-sync.ts') },
			{ find: /^@tikz-editor\/app\/platform\/current$/, replacement: path.resolve(__dirname, '../../packages/app/src/platform/current.ts') },
			{ find: /^@tikz-editor\/app\/platform\/types$/, replacement: path.resolve(__dirname, '../../packages/app/src/platform/types.ts') },
			{ find: /^@tikz-editor\/app\/store\/types$/, replacement: path.resolve(__dirname, '../../packages/app/src/store/types.ts') },
			{ find: /^@tikz-editor\/app\/workspace$/, replacement: path.resolve(__dirname, '../../packages/app/src/ui/workspace-apply.ts') },
			{ find: /^@tikz-editor\/lang-tikz$/, replacement: path.resolve(__dirname, '../../packages/lang-tikz/src/index.ts') },
			{ find: /^@tikz-editor\/lezer-tikz$/, replacement: path.resolve(__dirname, '../../packages/lezer-tikz/src/index.ts') },
			{ find: /^tikz-editor$/, replacement: path.resolve(__dirname, '../../packages/core/src/index.ts') },
			{ find: /^tikz-editor\/(.*)$/, replacement: path.resolve(__dirname, '../../packages/core/src/$1') },
		],
	},
	optimizeDeps: {
		exclude: ['mathlive'],
	},
	worker: {
		format: 'es',
	},
});
