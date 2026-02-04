import ms from 'ms';

export const version = "1.0.0";

export const start = async (ctx) => {
    const { app, log, emby } = ctx;

    const endpoint = '/EncodingDiagnostics/DiagnosticOptions';

    const getDiagnosticOptions = async () => {
        const res = await emby(endpoint);

        return res.data;
    }

    const setDiagnosticOptions = async (options) => emby.post(endpoint, options);

    const overrideDiagnostics = async () => {
        const diagnosticOptions = await getDiagnosticOptions();
        const transcodingOptions = diagnosticOptions.Object.TranscodingOptions;

        if (!transcodingOptions.DisableHardwareSubtitleOverlay && !transcodingOptions.DisableSubtitleFiltering) {
            log.debug('Transcoding options are already set correctly.');
            return;
        }

        transcodingOptions.DisableHardwareSubtitleOverlay = false;
        transcodingOptions.DisableSubtitleFiltering = false;

        await setDiagnosticOptions(diagnosticOptions.Object);

        log.info('Set transcoding options...');
    }

    overrideDiagnostics().catch(log.error);
    setInterval(() => overrideDiagnostics().catch(log.error), ms('5m'));
}