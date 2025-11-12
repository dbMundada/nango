import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

import archiver from 'archiver';

import { nangoConfigFile } from '@nangohq/nango-yaml';
import { report } from '@nangohq/utils';

import { NangoError } from '../../utils/error.js';
import errorManager from '../../utils/error.manager.js';

import type { DBSyncConfig, NangoProps } from '@nangohq/types';
import type { Response } from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const scriptTypeToPath: Record<NangoProps['scriptType'], string> = {
    'on-event': 'on-events',
    action: 'actions',
    sync: 'syncs',
    webhook: 'syncs'
};

const basePath = process.env['NANGO_INTEGRATIONS_FULL_PATH'] || path.resolve(__dirname, `../nango-integrations`);

// Console log to verify the path
console.log('[LocalFileService] basePath:', basePath);

class LocalFileService {
    public getIntegrationFile({
        scriptType,
        syncConfig,
        providerConfigKey
    }: {
        scriptType: NangoProps['scriptType'];
        syncConfig: DBSyncConfig;
        providerConfigKey: string;
    }) {
        try {
            const filePath = this.resolveIntegrationFile({ scriptType, syncConfig, providerConfigKey });
            const integrationFileContents = fs.readFileSync(filePath, 'utf8');
            return integrationFileContents;
        } catch (err) {
            console.log(err);
            return null;
        }
    }

    public putIntegrationFile({ filePath, fileContent }: { filePath: string; fileContent: string }) {
        try {
            const fp = path.join(basePath, filePath);
            fs.mkdirSync(fp.replace(path.basename(fp), ''), { recursive: true });
            fs.writeFileSync(fp, fileContent, 'utf8');

            return true;
        } catch (err) {
            report(err);
            return false;
        }
    }

    public checkForIntegrationSourceFile(fileName: string) {
        const filePath = path.resolve(basePath, fileName);
        let realPath;
        try {
            realPath = fs.realpathSync(filePath);
        } catch {
            realPath = filePath;
        }

        return {
            result: fs.existsSync(realPath),
            path: realPath
        };
    }

    private resolveTsFile({
        scriptName,
        providerConfigKey,
        syncConfig
    }: {
        scriptName: string;
        providerConfigKey: string;
        syncConfig: DBSyncConfig;
    }): null | string {
        const fileName = `${scriptName}.ts`;
        const nestedFilePath = `${providerConfigKey}/${scriptTypeToPath[syncConfig.type]}/${fileName}`;
        const nestedPath = path.resolve(basePath, nestedFilePath);
        if (this.checkForIntegrationSourceFile(nestedFilePath).result) {
            return nestedPath;
        }

        const tsFilePath = path.resolve(basePath, fileName);
        if (!this.checkForIntegrationSourceFile(fileName).result) {
            return null;
        }

        return tsFilePath;
    }

    /**
     * Zip And Send Files
     * @desc grab the files locally from the integrations path, zip and send
     * the archive
     */
    public async zipAndSendFiles({
        res,
        scriptName,
        providerConfigKey,
        syncConfig
    }: {
        res: Response;
        scriptName: string;
        providerConfigKey: string;
        syncConfig: DBSyncConfig;
    }) {
        const files: string[] = [];
        if (!syncConfig.sdk_version?.includes('-zero')) {
            const yamlPath = path.resolve(basePath, nangoConfigFile);
            const yamlExists = this.checkForIntegrationSourceFile(nangoConfigFile);
            if (!yamlExists.result) {
                errorManager.errResFromNangoErr(res, new NangoError('integration_file_not_found'));
                return;
            }
            files.push(yamlPath);
        }

        const tsFilePath = this.resolveTsFile({ scriptName, providerConfigKey, syncConfig });
        if (!tsFilePath) {
            errorManager.errResFromNangoErr(res, new NangoError('integration_file_not_found'));
            return;
        }
        files.push(tsFilePath);

        const archive = archiver('zip');

        archive.on('error', (err) => {
            report(err);

            errorManager.errResFromNangoErr(res, new NangoError('error_creating_zip_file'));
            return;
        });

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=nango-integrations.zip`);

        archive.pipe(res);

        for (const file of files) {
            archive.append(fs.createReadStream(file), { name: path.basename(file) });
        }

        await archive.finalize();
    }

    private resolveIntegrationFile({
        scriptType,
        syncConfig,
        providerConfigKey
    }: {
        scriptType: NangoProps['scriptType'];
        syncConfig: DBSyncConfig;
        providerConfigKey: string;
    }): string {
        if (syncConfig.sdk_version && syncConfig.sdk_version.includes('zero')) {
            return path.resolve(basePath, `build/${providerConfigKey}_${scriptTypeToPath[scriptType]}_${syncConfig.sync_name}.cjs`);
        } else {
            return path.resolve(basePath, `dist/${syncConfig.sync_name}-${providerConfigKey}.js`);
        }
    }

    // New method to get files from bundled integration templates
    public getTemplateFile(filePath: string): string | null {
        try {
            const fullPath = path.resolve(basePath, filePath);
            console.log('[LocalFileService] Attempting to read template file:', fullPath);
            
            if (fs.existsSync(fullPath)) {
                const content = fs.readFileSync(fullPath, 'utf8');
                console.log('[LocalFileService] Successfully read template file:', fullPath);
                return content;
            } else {
                console.log('[LocalFileService] Template file not found:', fullPath);
                return null;
            }
        } catch (err) {
            console.error('[LocalFileService] Error reading template file:', err);
            return null;
        }
    }

    // Copy template file to destination for template deployments
    public copyTemplateFile({ sourcePath, destinationPath }: { sourcePath: string; destinationPath: string }): boolean {
        try {
            const sourceFullPath = path.resolve(basePath, sourcePath);
            const destFullPath = path.resolve(basePath, destinationPath);
            
            console.log('[LocalFileService] Copying template file from:', sourceFullPath, 'to:', destFullPath);
            
            if (!fs.existsSync(sourceFullPath)) {
                console.error('[LocalFileService] Source template file does not exist:', sourceFullPath);
                return false;
            }

            // Ensure destination directory exists
            const destDir = path.dirname(destFullPath);
            fs.mkdirSync(destDir, { recursive: true });

            // Copy the file
            fs.copyFileSync(sourceFullPath, destFullPath);
            console.log('[LocalFileService] Successfully copied template file');
            return true;
        } catch (err) {
            console.error('[LocalFileService] Error copying template file:', err);
            return false;
        }
    }
}

export default new LocalFileService();
