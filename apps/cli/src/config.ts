/**
 * 配置解析已下沉到 @water/core（CLI / Server 共用），此文件仅为兼容保留转发。
 */
export { resolveConfig, loadFileConfig, PROTOCOL_DEFAULTS } from '@water/core';
export type { WaterConfig, ConfigFlags as CliFlags } from '@water/core';
