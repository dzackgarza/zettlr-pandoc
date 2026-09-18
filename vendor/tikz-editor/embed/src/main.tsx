import { StrictMode, Suspense, lazy, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { setActiveEditorPlatform } from '@tikz-editor/app/platform/current';
import { useEditorStore } from '@tikz-editor/app/store';
import type { EditorPlatform } from '@tikz-editor/app/platform/types';
import type { DocumentFileRef } from '@tikz-editor/app/store/types';
import './styles.css';

const App = lazy(async () => {
	const mod = await import('@tikz-editor/app');
	return { default: mod.App };
});

type HostSettingsPatch = {
	general?: {
		colorScheme?: 'system' | 'light' | 'dark';
		canvasInvert?: boolean;
	};
};

type HostMessage = {
	action?: string;
	event?: string;
	source?: string;
	xml?: string;
	revision?: number;
	format?: string;
	autosave?: 0 | 1 | boolean;
	fileName?: string;
	name?: string;
	modified?: boolean;
	settings?: HostSettingsPatch;
};

type PendingEditorMessage = {
	source: string;
	svg: string;
	revision: number;
};

const WORKSPACE_KEY = 'tikz-editor:workspace';
const SETTINGS_KEY = 'tikz-editor:settings';
const STORAGE_HASH_KEY = 'storage';
const SETTINGS_VERSION = 1;
const CHANGE_THROTTLE_MS = 250;
const AUTOSAVE_DEBOUNCE_MS = 1000;
const TEXT_FILE_ACCEPT = '.tex,.tikz,.pgf,.svg,.ipe,text/plain,text/x-tex,text/xml,application/xml,image/svg+xml';
const DEFAULT_SOURCE = String.raw`\begin{tikzpicture}
  \draw[thick, blue] (0,0) circle (1cm);
  \node at (0,0) {TikZ};
\end{tikzpicture}
`;

let autosaveEnabled = false;
let lastSavedSource = DEFAULT_SOURCE;
let lastKnownSvg = '';
let currentFileName = 'document.tikz';
let currentHostRevision = 0;
const persistenceValues = new Map<string, string>();

function postToHost(message: Record<string, unknown>) {
	window.parent?.postMessage(JSON.stringify(message), '*');
}

function sourceFromMessage(message: HostMessage): string | null {
	if (typeof message.source === 'string') return message.source;
	if (typeof message.xml === 'string') return message.xml;
	return null;
}

function wantsSvg(format?: string) {
	return typeof format === 'string' && format.toLowerCase().includes('svg');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function persistHostSettings(settings?: HostSettingsPatch) {
	if (!settings?.general) return;

	const currentRaw = persistenceValues.get(SETTINGS_KEY);
	let currentSettings: Record<string, unknown> = {};
	try {
		const parsed = currentRaw ? JSON.parse(currentRaw) as unknown : null;
		if (isRecord(parsed) && isRecord(parsed.settings)) {
			currentSettings = parsed.settings;
		}
	} catch {}

	const currentGeneral = isRecord(currentSettings.general) ? currentSettings.general : {};
	const nextRaw = JSON.stringify({
		settingsVersion: SETTINGS_VERSION,
		settings: {
			...currentSettings,
			general: {
				...currentGeneral,
				...settings.general,
			},
		},
	});

	if (nextRaw === currentRaw) return;
	persistenceValues.set(SETTINGS_KEY, nextRaw);
	postToHost({ event: 'persistence-save', key: SETTINGS_KEY, value: nextRaw });
}

function applyHostSettings(settings?: HostSettingsPatch) {
	const general = settings?.general;
	if (!general) return;

	if (general.colorScheme === 'light' || general.colorScheme === 'dark') {
		document.documentElement.dataset.colorScheme = general.colorScheme;
	} else if (general.colorScheme === 'system') {
		delete document.documentElement.dataset.colorScheme;
	}

	if (typeof general.canvasInvert === 'boolean') {
		if (general.canvasInvert) {
			document.documentElement.dataset.canvasInvert = 'true';
		} else {
			delete document.documentElement.dataset.canvasInvert;
		}
	}
}

function makeExportPayload(format: string | undefined) {
	const source = useEditorStore.getState().source;
	const requestedSvg = wantsSvg(format);
	const data = requestedSvg ? lastKnownSvg : source;

	if (requestedSvg && !lastKnownSvg.trim()) {
		return {
			event: 'export',
			revision: currentHostRevision,
			format: format ?? 'svg',
			error: 'SVG is not ready yet. Wait for the preview to finish rendering and try again.',
			source,
			xml: source,
			svg: '',
			data: '',
		};
	}

	return {
		event: 'export',
		revision: currentHostRevision,
		format: format ?? 'tikz',
		data,
		source,
		xml: source,
		svg: lastKnownSvg,
	};
}

function makeFileRef(name = currentFileName): DocumentFileRef {
	return { kind: 'virtual', name };
}

function openTextFileWithPicker(): Promise<{ source: string; fileRef: DocumentFileRef | null } | null> {
	if (typeof document === 'undefined' || typeof FileReader === 'undefined') return Promise.resolve(null);

	return new Promise((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = TEXT_FILE_ACCEPT;
		input.style.display = 'none';

		let settled = false;
		let changed = false;

		const finish = (result: { source: string; fileRef: DocumentFileRef | null } | null) => {
			if (settled) return;
			settled = true;
			window.removeEventListener('focus', handleFocus);
			input.remove();
			resolve(result);
		};

		const handleFocus = () => {
			window.setTimeout(() => {
				if (!changed) finish(null);
			}, 300);
		};

		input.addEventListener('change', () => {
			changed = true;
			const file = input.files?.[0];
			if (!file) {
				finish(null);
				return;
			}

			const reader = new FileReader();
			reader.onerror = () => finish(null);
			reader.onload = () => {
				finish({
					source: typeof reader.result === 'string' ? reader.result : '',
					fileRef: makeFileRef(file.name || currentFileName),
				});
			};
			reader.readAsText(file);
		}, { once: true });

		document.body.appendChild(input);
		window.addEventListener('focus', handleFocus, { once: true });
		input.click();
	});
}

function makeWorkspaceSeed(source: string, fileName = currentFileName) {
	return JSON.stringify({
		workspaceVersion: 2,
		documents: [{
			id: 'zettlr-document',
			title: fileName,
			source,
			savedSource: source,
			activeFigureId: null,
			fileRef: makeFileRef(fileName),
			diskRevision: null,
			lastKnownDiskSource: source,
			externalChangeStatus: 'none',
			assistantThreadId: null,
			assistantWorkspacePath: null,
			assistantFigurePath: null,
			assistantPreviewPath: null,
		}],
		tabOrder: ['zettlr-document'],
		activeDocumentId: 'zettlr-document',
		recentDocumentIds: ['zettlr-document'],
	});
}

function createMemoryPersistence(initialSource: string): EditorPlatform['persistence'] {
	persistenceValues.clear();
	const seededStorage = new URLSearchParams(window.location.hash.slice(1)).get(STORAGE_HASH_KEY);
	if (seededStorage) {
		try {
			Object.entries(JSON.parse(seededStorage) as Record<string, string>).forEach(([key, value]) => {
				if (key !== WORKSPACE_KEY && typeof value === 'string') persistenceValues.set(key, value);
			});
		} catch {}
	}
	persistenceValues.set(WORKSPACE_KEY, makeWorkspaceSeed(initialSource));
	return {
		load: (key) => persistenceValues.get(key) ?? null,
		save: (key, value) => {
			persistenceValues.set(key, value);
			if (key !== WORKSPACE_KEY) postToHost({ event: 'persistence-save', key, value });
		},
	};
}

function createEmbedPlatform(initialSource: string): EditorPlatform {
	return {
		id: 'zettlr-embed',
		persistence: createMemoryPersistence(initialSource),
		clipboard: {
			readText: async () => navigator.clipboard?.readText?.() ?? '',
			writeText: async (text) => { await navigator.clipboard?.writeText?.(text); },
		},
		menu: {
			usesNativeMenuBar: false,
			usesNativeContextMenus: false,
			syncNativeMenu: () => {},
			showNativeContextMenu: () => {},
		},
		window: {
			setDocumentState: ({ dirty }) => {
				postToHost({ event: 'status', modified: Boolean(dirty) });
			},
			openExternalUrl: (url) => {
				const opened = window.open(url, '_blank', 'noopener,noreferrer');
				return opened != null;
			},
			showMessage: ({ title, message, kind }) => {
				postToHost({ event: 'message', title, message, kind });
			},
		},
		files: {
			openText: async () => openTextFileWithPicker(),
			saveText: async (text, options) => {
				lastSavedSource = text;
				currentFileName = options?.suggestedName ?? options?.fileRef?.name ?? currentFileName;
				postToHost({ event: 'save', revision: currentHostRevision, source: text, xml: text, svg: lastKnownSvg, fileName: currentFileName });
				return { status: 'saved', fileRef: makeFileRef(currentFileName) };
			},
			exportFile: async (content, options) => {
				const format = options.mimeType || options.fileName;
				postToHost(wantsSvg(format) ? makeExportPayload(format) : { ...makeExportPayload(format), data: content });

				// Returning false keeps the upstream browser download fallback active for menu exports.
				// Parent-initiated exports still use the explicit `action: export` message path below.
				return false;
			},
		},
	};
}

function loadIntoEditor(source: string, fileName = currentFileName) {
	currentFileName = fileName;
	lastSavedSource = source;
	lastKnownSvg = '';
	const store = useEditorStore.getState();
	store.dispatch({ type: 'CODE_EDITED', source });
	store.dispatch({ type: 'MARK_DOCUMENT_SAVED', fileRef: makeFileRef(fileName), lastKnownDiskSource: source });
	postToHost({ event: 'loaded', revision: currentHostRevision });
}

function HostBridge() {
	const previousSourceRef = useRef<string | null>(null);
	const previousSvgRef = useRef<string>('');
	const pendingChangeRef = useRef<PendingEditorMessage | null>(null);
	const pendingAutosaveRef = useRef<PendingEditorMessage | null>(null);
	const changeTimerRef = useRef<number | null>(null);
	const autosaveTimerRef = useRef<number | null>(null);

	useEffect(() => {
		postToHost({ event: 'init', version: '0.5.2-zettlr.1' });

		const flushChange = () => {
			changeTimerRef.current = null;
			const pending = pendingChangeRef.current;
			pendingChangeRef.current = null;
			if (!pending) return;
			postToHost({ event: 'change', revision: pending.revision, source: pending.source, xml: pending.source, svg: pending.svg });
		};

		const scheduleChange = (source: string, svg: string, revision: number) => {
			pendingChangeRef.current = { source, svg, revision };
			if (changeTimerRef.current !== null) return;
			changeTimerRef.current = window.setTimeout(flushChange, CHANGE_THROTTLE_MS);
		};

		const flushAutosave = () => {
			autosaveTimerRef.current = null;
			const pending = pendingAutosaveRef.current;
			pendingAutosaveRef.current = null;
			if (!pending) return;
			postToHost({ event: 'autosave', revision: pending.revision, source: pending.source, xml: pending.source, svg: pending.svg });
		};

		const scheduleAutosave = (source: string, svg: string, revision: number) => {
			pendingAutosaveRef.current = { source, svg, revision };
			if (autosaveTimerRef.current !== null) {
				window.clearTimeout(autosaveTimerRef.current);
			}
			autosaveTimerRef.current = window.setTimeout(flushAutosave, AUTOSAVE_DEBOUNCE_MS);
		};

		const flushPendingEditorMessages = () => {
			if (changeTimerRef.current !== null) {
				window.clearTimeout(changeTimerRef.current);
				flushChange();
			}
			if (autosaveTimerRef.current !== null) {
				window.clearTimeout(autosaveTimerRef.current);
				flushAutosave();
			}
		};

		const unsubscribe = useEditorStore.subscribe((state) => {
			const nextSvg = state.snapshot.svg?.svg ?? '';
			if (nextSvg && nextSvg !== previousSvgRef.current) {
				previousSvgRef.current = nextSvg;
				lastKnownSvg = nextSvg;
			}

			if (previousSourceRef.current === null) {
				previousSourceRef.current = state.source;
				return;
			}
			if (state.source === previousSourceRef.current) return;
			previousSourceRef.current = state.source;
			scheduleChange(state.source, lastKnownSvg, currentHostRevision);
			if (autosaveEnabled) {
				scheduleAutosave(state.source, lastKnownSvg, currentHostRevision);
			}
		});

		const handleMessage = (event: MessageEvent) => {
			let message: HostMessage | null = null;
			if (typeof event.data === 'string') {
				try { message = JSON.parse(event.data) as HostMessage; } catch { return; }
			} else if (event.data && typeof event.data === 'object') {
				message = event.data as HostMessage;
			}
			if (!message) return;
			const action = message.action || message.event;
			if (action === 'load') {
				if (typeof message.revision === 'number' && Number.isInteger(message.revision)) {
					currentHostRevision = message.revision;
				}
				applyHostSettings(message.settings);
				persistHostSettings(message.settings);
				autosaveEnabled = Boolean(message.autosave);
				pendingChangeRef.current = null;
				pendingAutosaveRef.current = null;
				loadIntoEditor(sourceFromMessage(message) ?? DEFAULT_SOURCE, message.fileName ?? message.name ?? currentFileName);
			} else if (action === 'settings') {
				applyHostSettings(message.settings);
				persistHostSettings(message.settings);
			} else if (action === 'save') {
				flushPendingEditorMessages();
				const source = useEditorStore.getState().source;
				lastSavedSource = source;
				useEditorStore.getState().dispatch({ type: 'MARK_DOCUMENT_SAVED', fileRef: makeFileRef(currentFileName), lastKnownDiskSource: source });
				postToHost({ event: 'save', revision: currentHostRevision, source, xml: source, svg: lastKnownSvg, fileName: currentFileName });
			} else if (action === 'export') {
				flushPendingEditorMessages();
				postToHost(makeExportPayload(message.format));
			} else if (action === 'status' && typeof message.modified === 'boolean' && !message.modified) {
				useEditorStore.getState().dispatch({ type: 'MARK_DOCUMENT_SAVED', fileRef: makeFileRef(currentFileName), lastKnownDiskSource: useEditorStore.getState().source });
			}
		};

		window.addEventListener('message', handleMessage);
		return () => {
			unsubscribe();
			window.removeEventListener('message', handleMessage);
			if (changeTimerRef.current !== null) window.clearTimeout(changeTimerRef.current);
			if (autosaveTimerRef.current !== null) window.clearTimeout(autosaveTimerRef.current);
		};
	}, []);

	return null;
}

setActiveEditorPlatform(createEmbedPlatform(DEFAULT_SOURCE));

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<HostBridge />
		<Suspense fallback={null}>
			<App />
		</Suspense>
	</StrictMode>,
);
