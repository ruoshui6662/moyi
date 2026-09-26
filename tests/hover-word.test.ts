import { describe, expect, it } from 'vitest';
import { extractHoverWord } from '../chrome-plugin/src/utils/selectionLookup';

describe('extractHoverWord', () => {
  it('拉丁词按字符边界取词（光标在词中任意位置结果一致）', () => {
    const text = 'Deploy the Kubernetes cluster now.';
    for (const offset of [11, 13, 18]) {
      expect(extractHoverWord(text, offset)?.word).toBe('Kubernetes');
    }
    expect(extractHoverWord(text, 0)?.word).toBe('Deploy');
    expect(extractHoverWord(text, 1)?.word).toBe('Deploy');
  });

  it('连字符与撇号算词内字符', () => {
    expect(extractHoverWord('a well-known fact', 4)?.word).toBe('well-known');
    expect(extractHoverWord("it's fine", 1)?.word).toBe("it's");
  });

  it('数字与单字符无查词价值', () => {
    expect(extractHoverWord('port 8080 open', 7)).toBeNull();
    expect(extractHoverWord('a b c', 0)).toBeNull();
  });

  it('CJK 取连续汉字串', () => {
    expect(extractHoverWord('这是容器编排的原理', 4)?.word).toContain('容器编排');
    expect(extractHoverWord('これはテストです', 3)?.word).toBe('これはテストです');
  });

  it('长 CJK 串居中截取 8 字（不吞整段）', () => {
    const long = '一'.repeat(30);
    const hit = extractHoverWord(long, 15);
    expect(hit?.word).toHaveLength(8);
    expect(hit?.start).toBeGreaterThan(0);
  });

  it('空白与标点返回 null；越界 offset 夹取', () => {
    expect(extractHoverWord('hello, world', 5)).toBeNull();
    expect(extractHoverWord('hello', 999)?.word).toBe('hello');
    expect(extractHoverWord('', 0)).toBeNull();
  });
});
