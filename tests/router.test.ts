import { describe, it, expect } from 'vitest';
import { classify, pickAgentForKey } from '../src/core/router.js';

describe('classify', () => {
  it('direct: greetings + simple questions', () => {
    for (const g of [
      '你好',
      'hi',
      '在吗',
      '谢谢',
      '什么是 RAG?',
      '为什么天空是蓝的？',
      '1 + 1 = ?',
      '解释一下闭包',
    ]) {
      expect(classify(g)).toBe('direct');
    }
  });

  it('single: focused tasks', () => {
    for (const g of [
      '帮我写一个二分查找函数',
      '搜一下今天的天气',
      '审查 src/foo.py 的安全问题',
      '把这段中文翻译成英文：我喜欢猫',
    ]) {
      expect(classify(g)).toBe('single');
    }
  });

  it('orchestrate: multi-step plans', () => {
    for (const g of [
      '先帮我分析这段代码，然后重构它，最后写测试',
      '首先调研一下市场上有哪些方案，其次对比性能，最后给出推荐',
      '1. 创建数据库迁移\n2. 写 API\n3. 加测试\n4. 部署',
      'step 1: design the schema. step 2: write migrations. then, write tests. finally deploy.',
    ]) {
      expect(classify(g)).toBe('orchestrate');
    }
  });

  it('empty goal is direct', () => {
    expect(classify('')).toBe('direct');
    expect(classify('   ')).toBe('direct');
  });

  it('long code block is orchestrate', () => {
    const goal =
      '帮我处理这段代码并先重构再加测试：\n```python\n' +
      'def foo():\n    return 1\n'.repeat(30) +
      '```\n';
    expect(classify(goal)).toBe('orchestrate');
  });

  it('inline enumerated list is orchestrate', () => {
    for (const g of ['1. 拉数据 2. 分析 3. 出图', 'step 1. login 2. fetch 3. render']) {
      expect(classify(g)).toBe('orchestrate');
    }
  });

  it('two inline items is NOT orchestrate', () => {
    expect(classify('1. 你好 2. 谢谢')).not.toBe('orchestrate');
  });
});

describe('pickAgentForKey', () => {
  const all = new Set(['fog', 'rain', 'frost', 'snow', 'dew', 'fair']);

  it('security keyword picks frost', () => {
    expect(pickAgentForKey('帮我做安全审查', all)).toBe('frost');
  });
  it('research keyword picks fog', () => {
    expect(pickAgentForKey('搜一下最新的 React 文档', all)).toBe('fog');
  });
  it('greeting picks fair', () => {
    expect(pickAgentForKey('你好啊', all)).toBe('fair');
  });
  it('falls back to rain', () => {
    expect(pickAgentForKey('处理这个东西', all)).toBe('rain');
  });
  it('binary search picks rain not fog', () => {
    expect(pickAgentForKey('帮我写一个二分查找', all)).toBe('rain');
    expect(pickAgentForKey('实现一个排序函数', all)).toBe('rain');
  });
  it('skips missing agents', () => {
    const avail = new Set(['rain', 'snow']);
    expect(avail.has(pickAgentForKey('做安全审查', avail))).toBe(true);
  });
  it('single agent available', () => {
    expect(pickAgentForKey('anything', new Set(['rain']))).toBe('rain');
  });
});
