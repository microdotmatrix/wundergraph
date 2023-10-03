import { CodeGenerationConfig, ResolvedWunderGraphConfig } from '../configure';
import path from 'path';
import * as fs from 'fs';
import { Logger } from '../logger';

export interface TemplateOutputFile {
	path: string;
	content: string;
	header?: string;
}

export interface Template {
	generate: (config: CodeGenerationConfig) => Promise<TemplateOutputFile[]>;
	dependencies?: () => Template[];
	precedence?: number;
	// Whether this template takes into account its output path during code generation
	// If true, its output won't be cached. If the field is not specified, it is assumed
	// to be false.
	usesOutputPath?: boolean;
}

export interface CodeGenConfig {
	basePath: string;
	wunderGraphConfig: ResolvedWunderGraphConfig;
	templates: Template[];
}

export interface CodeGenOutWriter {
	writeFileSync: (path: string, content: string) => void;
}

class FileSystem implements CodeGenOutWriter {
	writeFileSync(path: string, content: string): void {
		ensurePath(path);
		fs.writeFileSync(path, content);
	}
}

const ensurePath = (filePath: string) => {
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
};

export const collectAllTemplates = (templates: Template[], maxTemplateDepth = 25, level = 0) => {
	const allTemplates = new Map<string, Template>();

	if (level > maxTemplateDepth) {
		return allTemplates.values();
	}

	for (const tpl of templates) {
		allTemplates.set(tpl.constructor.name, tpl);
		const deps = tpl?.dependencies?.() || [];
		for (const dep of collectAllTemplates(deps, maxTemplateDepth, level + 1)) {
			allTemplates.set(dep.constructor.name, dep);
		}
	}

	const all = allTemplates.values();
	return Array.from(all).sort((a, b) => {
		return (b.precedence || 0) - (a.precedence || 0);
	});
};

export const doNotEditHeader = '// Code generated by wunderctl. DO NOT EDIT.\n\n';

interface CodeGeneratorCacheEntry {
	result: TemplateOutputFile[];
}
export class CodeGenerator {
	private cache: Map<string, CodeGeneratorCacheEntry> = new Map();
	async generate(config: CodeGenConfig, customOutWriter?: CodeGenOutWriter) {
		config.templates = Array.from(collectAllTemplates(config.templates));

		const generateConfig: CodeGenerationConfig = {
			config: config.wunderGraphConfig,
			outPath: config.basePath,
			wunderGraphDir: process.env.WG_DIR_ABS!,
		};

		const outWriter = customOutWriter || new FileSystem();
		const generators: Promise<TemplateOutputFile[]>[] = [];
		config.templates.forEach((template) => {
			const templateName = template.constructor.name;
			const cacheEntry = this.cache.get(templateName);
			if (cacheEntry) {
				Logger.trace(`cache hit for template ${template.constructor.name}`);
				generators.push(Promise.resolve(cacheEntry.result));
			} else {
				const before = Date.now();
				Logger.trace(`generating ${template.constructor.name}`);
				generators.push(
					template.generate(generateConfig).then((result) => {
						if (!(template.usesOutputPath ?? false)) {
							this.cache.set(templateName, {
								result,
							});
						}
						return result;
					})
				);
				Logger.trace(`${template.constructor.name} took ${Date.now() - before}ms`);
			}
		});
		const resolved = await Promise.all(generators);
		const rawOutFiles: TemplateOutputFile[] = resolved.reduce((previousValue, currentValue) => [
			...previousValue,
			...currentValue,
		]);
		const outFiles = mergeTemplateOutput(rawOutFiles);
		outFiles.forEach((file) => {
			const content = `${file.header || ''}${file.content}`;
			const outPath = path.join(config.basePath, file.path);
			outWriter.writeFileSync(outPath, content);
			Logger.debug(`${outPath} updated`);
		});
	}
}

/**
 * Combines multiple template outputs, that might refer to the same files, consolidating
 * all outputs referring to the same file into one, without altering the TemplateOutputFile
 * received as input. When multiple files are merged, the header of all but the first one
 * is ignored.
 *
 * @param outFiles Merged output files for templates
 * @returns An array with all the TemplateOutputFile referring to the same file merged into one
 */
export const mergeTemplateOutput = (outFiles: TemplateOutputFile[]): TemplateOutputFile[] => {
	const files: Map<string, TemplateOutputFile> = new Map();
	outFiles.forEach((file) => {
		const existing = files.get(file.path);
		if (existing) {
			existing.content += '\n\n' + file.content;
		} else {
			files.set(file.path, Object.assign({}, file));
		}
	});
	const merged = Array.from(files.values());
	merged.forEach((file) => {
		while (file.content.search('\n\n\n') !== -1) {
			file.content = file.content.replace('\n\n\n', '\n\n');
		}
	});
	return merged;
};

export { visitJSONSchema } from './jsonschema';
export { hasInput, modelImports, configurationHash } from './templates/typescript/helpers';
