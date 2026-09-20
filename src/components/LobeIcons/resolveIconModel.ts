/**
 * @lobehub/icons 的 modelConfig 通过关键词正则匹配模型 id 决定图标，
 * Kimi/Moonshot 图标仅匹配 'kimi'、'moonshot'。Kimi Code 的 k3 / k3-256k
 * 两个模型 id 不含上述关键词，会落到默认图标。此处将已知 id 别名为
 * 可匹配的关键词，避免修改 node_modules 内的依赖包。
 */
const MODEL_ICON_ALIASES: [RegExp, string][] = [[/^k3(?:-|$)/i, 'kimi']];

export const resolveIconModel = (model?: string): string | undefined => {
  if (!model) return model;

  const alias = MODEL_ICON_ALIASES.find(([pattern]) => pattern.test(model));

  return alias ? alias[1] : model;
};
