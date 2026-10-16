const api = window.downloader;
const byId = (id) => document.getElementById(id);
const placeholderArtwork = 'assets/app-icon/png/256.png';
let busy = false;
let lastJobUrl;
let warningCount = -1;
let displayedCover;
document.documentElement.dataset.platform = api.platform;

function setTheme(theme) {
    const dark = theme === 'Dark';
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'Dark' : 'Light');
    byId('theme-button').textContent = dark ? 'Light theme' : 'Dark theme';
    byId('theme-button').setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} theme`);
    api.setWindowTheme(dark ? 'Dark' : 'Light');
}
setTheme(localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'Dark' : 'Light'));
byId('theme-button').addEventListener('click', () => setTheme(document.documentElement.classList.contains('dark') ? 'Light' : 'Dark'));

const appMenuButton = byId('app-menu-button');
appMenuButton.addEventListener('click', async () => {
    if (appMenuButton.getAttribute('aria-expanded') === 'true') return;
    const bounds = appMenuButton.getBoundingClientRect();
    appMenuButton.setAttribute('aria-expanded', 'true');
    try {
        await api.showAppMenu({ x: Math.round(bounds.left), y: Math.round(bounds.bottom + 4) });
    } catch {
        // The window can close while its native popup menu is open.
    } finally {
        appMenuButton.setAttribute('aria-expanded', 'false');
    }
});
appMenuButton.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
        event.preventDefault();
        appMenuButton.click();
    }
});

api.onEngineState((state) => {
    const origin = state.source === 'nightly' ? 'nightly' : 'bundled';
    byId('engine-status').textContent = `yt-dlp ${state.version} (${origin}) · ${state.message || 'Nightly updates checked automatically.'}`;
    byId('about-engine').textContent = state.version ? `yt-dlp ${state.version} · ${origin}` : 'Preparing…';
});

byId('cover-search').addEventListener('change', (event) => {
    byId('cover-search-input').hidden = !event.target.checked;
    byId('cover-search-url').required = event.target.checked;
    if (event.target.checked) byId('cover-search-url').focus();
});

byId('download-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    const url = byId('url-input').value.trim();
    if (!url) return;
    byId('download-button').disabled = true;
    api.download({ url, coverSearch: byId('cover-search').checked, coverSearchTitle: byId('cover-search-url').value.trim() });
});

byId('open-downloads').addEventListener('click', () => api.openDownloads());
byId('reveal-download').addEventListener('click', () => api.revealDownload());
byId('song-artwork').addEventListener('error', () => {
    if (byId('song-artwork').getAttribute('src') !== placeholderArtwork) {
        byId('song-artwork').src = placeholderArtwork;
        byId('song-artwork').classList.add('placeholder-artwork');
    }
});

api.onState((state) => {
    busy = state.busy;
    byId('download-button').disabled = busy;
    byId('download-button-label').textContent = busy ? 'Download in progress…' : 'Download MP3';
    for (const id of ['url-input', 'cover-search', 'cover-search-url']) byId(id).disabled = busy;
    byId('download-form').setAttribute('aria-busy', String(busy));
    byId('accept-update').disabled = busy;
    byId('accept-update').title = busy ? 'Wait for the download to finish before restarting.' : '';
    if (state.url && state.url !== lastJobUrl) {
        byId('url-input').value = state.url;
        lastJobUrl = state.url;
    }

    byId('download-status').textContent = state.status;
    if (state.progress === null) byId('progress').removeAttribute('value');
    else byId('progress').value = state.progress;
    byId('progress-label').textContent = state.progress === null || (!busy && state.progress === 0) ? '' : `${state.progress}%`;
    byId('playlist').textContent = state.playlist;
    byId('queue-status').hidden = !state.queued;
    byId('queue-status').textContent = `${state.queued} more ${state.queued === 1 ? 'link' : 'links'} queued`;
    byId('error-message').hidden = !state.error;
    byId('error-message').textContent = state.error;
    byId('reveal-download').hidden = !state.canReveal;

    const song = state.song;
    const pendingTags = busy && song?.metadataPending;
    const finishingTags = state.status === 'Finishing MP3 tag lookup';
    if (pendingTags) {
        // The main headline reflects the audio job, not its optional metadata
        // lookup. Missing tags never mean yt-dlp is waiting for YouTube Music.
        byId('song-title').textContent = finishingTags ? 'Adding song details'
            : state.status === 'Converting to MP3' ? 'Creating your MP3'
                : state.status === 'Downloading audio' ? 'Your audio is downloading'
                    : 'Preparing your download';
        byId('song-artist').textContent = finishingTags
            ? 'Audio converted. Finishing song tags and artwork.'
            : 'Song tags and artwork are loading in the background.';
    } else {
        byId('song-title').textContent = song?.title || (state.error ? 'Download interrupted'
            : song?.metadataPending ? 'Track unavailable' : 'Your next favorite');
        byId('song-artist').textContent = song?.metadataPending ? 'Song details were not loaded.'
            : song ? song.metadataStatus || song.artist.join(', ') : 'Track details will appear here';
    }
    byId('song-source').hidden = !song?.source;
    byId('song-source').textContent = song?.source ? `Tags: ${song.source}` : '';
    const cover = song?.cover || placeholderArtwork;
    if (cover !== displayedCover) {
        displayedCover = cover;
        byId('song-artwork').src = cover;
        byId('song-artwork').classList.toggle('placeholder-artwork', cover === placeholderArtwork);
    }

    byId('download-notes').hidden = !state.warnings.length;
    byId('notes-summary').textContent = `Download notes (${state.warnings.length})`;
    if (warningCount !== state.warnings.length) {
        warningCount = state.warnings.length;
        byId('warnings-list').replaceChildren(...state.warnings.map((warning) => {
            const item = document.createElement('li');
            item.textContent = warning;
            return item;
        }));
    }
});

api.onComplete((title) => {
    try { new Notification('Download complete', { body: `${title} has been saved to Downloads.` }); }
    catch { /* Desktop notification availability must not affect downloads. */ }
});

const aboutDialog = byId('about-dialog');
api.onAbout((info) => {
    byId('about-version').textContent = `Version ${info.version}`;
    byId('about-author').textContent = info.author;
    byId('about-link-error').hidden = true;
    if (!aboutDialog.open) aboutDialog.showModal();
});
byId('close-about').addEventListener('click', () => aboutDialog.close());
aboutDialog.addEventListener('click', (event) => {
    if (event.target !== aboutDialog) return;
    const bounds = aboutDialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
        aboutDialog.close();
    }
});
aboutDialog.addEventListener('close', () => {
    if (!byId('update-dialog').open) appMenuButton.focus();
});
for (const link of aboutDialog.querySelectorAll('[data-project-link]')) {
    link.addEventListener('click', async (event) => {
        event.preventDefault();
        byId('about-link-error').hidden = true;
        const opened = await api.openProjectLink(link.dataset.projectLink).catch(() => false);
        byId('about-link-error').textContent = opened ? '' : `Could not open your browser. Copy this link to open it manually: ${link.href}`;
        byId('about-link-error').hidden = opened;
    });
}

const updateDialog = byId('update-dialog');
const dialogs = [aboutDialog, updateDialog];
let reportedModalDepth = 0;
const syncWindowControls = () => {
    const depth = dialogs.filter((dialog) => dialog.matches(':modal')).length;
    if (depth === reportedModalDepth) return;
    reportedModalDepth = depth;
    api.setWindowModalDepth(depth);
};
// Observing open handles buttons, Escape, backdrop dismissal, and stacked
// dialogs without requiring every close path to restore native control colors.
const dialogObserver = new MutationObserver(syncWindowControls);
for (const dialog of dialogs) dialogObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] });
api.onUpdate((info) => {
    byId('update-version').textContent = `Version ${info.version}`;
    const notes = Array.isArray(info.releaseNotes) ? info.releaseNotes.map((entry) => entry.note || '').join('\n\n') : info.releaseNotes || '';
    // Extract readable release notes without inserting remote HTML into the UI.
    const parsed = new DOMParser().parseFromString(notes, 'text/html');
    parsed.querySelectorAll('script, style, iframe, object').forEach((node) => node.remove());
    parsed.querySelectorAll('p, li, h1, h2, h3, br').forEach((node) => node.append('\n'));
    byId('changelog').textContent = parsed.body.textContent.trim();
    if (!updateDialog.open) updateDialog.showModal();
});
byId('accept-update').addEventListener('click', () => { if (!busy) api.installUpdate(); });
for (const id of ['ignore-update', 'close-update']) byId(id).addEventListener('click', () => updateDialog.close());
api.ready();
