function fetchWithTimeout(input, options = {}) {
    const signal = options.signal || input?.signal;
    return fetch(input, {
        ...options,
        signal: AbortSignal.any([
            // This fetch is only used by the optional YouTube Music lookup.
            AbortSignal.timeout(15000),
            ...(signal ? [signal] : [])
        ])
    });
}

module.exports = { fetchWithTimeout };
