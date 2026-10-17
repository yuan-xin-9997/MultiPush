import type { Page } from 'playwright';
import { validateXiaohongshuPublishUrl } from './draft.ts';

/** Accessibility identifies the actual button even when its DOM is in a closed shadow root. */
export async function xiaohongshuActionPoint(page: Page, name: '发布' | '暂存离开') {
  validateXiaohongshuPublishUrl(page.url());
  const session = await page.context().newCDPSession(page);
  try {
    const tree = await session.send('Accessibility.getFullAXTree');
    const buttons = tree.nodes.filter(node => !node.ignored && node.role?.value === 'button' && node.name?.value === name);
    if (buttons.length !== 1 || !buttons[0].backendDOMNodeId || buttons[0].properties?.some(property => property.name === 'disabled' && property.value.value === true))
      throw new Error(`小红书${name}按钮不唯一或不可用`);
    const { model } = await session.send('DOM.getBoxModel', { backendNodeId: buttons[0].backendDOMNodeId });
    const point = { x: (model.content[0] + model.content[2] + model.content[4] + model.content[6]) / 4, y: (model.content[1] + model.content[3] + model.content[5] + model.content[7]) / 4 };
    const valid = await page.evaluate(point => {
      const hosts = [...document.querySelectorAll('xhs-publish-btn')];
      const hit = document.elementFromPoint(point.x, point.y);
      if (hosts.length !== 1 || hit !== hosts[0]) return false;
      const box = hosts[0].getBoundingClientRect();
      return point.x > box.left && point.x < box.right && point.y > box.top && point.y < box.bottom;
    }, point);
    if (!valid) throw new Error('小红书按钮被遮挡或闭合控件布局变化');
    return point;
  } finally { await session.detach(); }
}
