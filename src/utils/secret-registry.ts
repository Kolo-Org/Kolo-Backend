const inFlightSecrets = new Set<Buffer>();

export function registerSecret(buffer: Buffer): void {
    inFlightSecrets.add(buffer);
}

export function unregisterSecret(buffer: Buffer): void {
    inFlightSecrets.delete(buffer);
}

export function zeroAllInFlightSecrets(): void {
    for (const buf of inFlightSecrets) {
        try {
            buf.fill(0);
        } catch {
        }
    }
    inFlightSecrets.clear();
}