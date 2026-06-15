const esbuild = require("esbuild");
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',
	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

const extensionConfig = {
	entryPoints: ['src/extension.ts'],
	bundle: true,
	format: 'cjs',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	platform: 'node',
	outfile: 'dist/extension.js',
	external: ['vscode'],
	logLevel: 'silent',
	plugins: [esbuildProblemMatcherPlugin],
};

const webviewConfig = {
	entryPoints: ['src/webview/index.ts'],
	bundle: true,
	format: 'iife',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	platform: 'browser',
	outfile: 'dist/webview.js',
	logLevel: 'silent',
	plugins: [esbuildProblemMatcherPlugin],
};

async function main() {
	if (watch) {
		const extCtx = await esbuild.context(extensionConfig);
		const webCtx = await esbuild.context(webviewConfig);
		await Promise.all([extCtx.watch(), webCtx.watch()]);
	} else {
		const extCtx = await esbuild.context(extensionConfig);
		await extCtx.rebuild();
		await extCtx.dispose();

		const webCtx = await esbuild.context(webviewConfig);
		await webCtx.rebuild();
		await webCtx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
