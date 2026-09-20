import { describe, expect, it } from 'vitest';

import { normalizeAskUserQuestions } from './normalize';

describe('normalizeAskUserQuestions', () => {
  it('keeps valid question arrays', () => {
    const questions = normalizeAskUserQuestions({
      questions: [
        {
          header: 'Scope',
          multiSelect: true,
          options: [
            { description: 'Fix the crash only', label: 'Narrow' },
            { description: 'Also harden related renderers', label: 'Full' },
          ],
          question: 'How broad should the fix be?',
        },
      ],
    });

    expect(questions).toEqual([
      {
        header: 'Scope',
        multiSelect: true,
        options: [
          { description: 'Fix the crash only', label: 'Narrow' },
          { description: 'Also harden related renderers', label: 'Full' },
        ],
        question: 'How broad should the fix be?',
      },
    ]);
  });

  it('preserves stable option ids while stripping unknown option fields', () => {
    const questions = normalizeAskUserQuestions({
      questions: [
        {
          header: 'Permission',
          options: [
            { id: 'allow-once', ignored: 'raw', label: 'Continue' },
            { id: 'reject-once', label: 'Continue' },
          ],
          question: 'Edit README?',
        },
      ],
    });

    expect(questions[0].options).toEqual([
      { id: 'allow-once', label: 'Continue' },
      { id: 'reject-once', label: 'Continue' },
    ]);
  });

  it('accepts a single question object for stale payloads', () => {
    const questions = normalizeAskUserQuestions({
      questions: {
        header: 'Mode',
        options: [{ label: 'Auto' }, { description: 'Manual path', label: 'Manual' }],
        question: 'Which mode?',
      },
    });

    expect(questions).toEqual([
      {
        header: 'Mode',
        options: [{ label: 'Auto' }, { description: 'Manual path', label: 'Manual' }],
        question: 'Which mode?',
      },
    ]);
  });

  it('drops malformed question payloads instead of returning non-arrays', () => {
    expect(normalizeAskUserQuestions({ questions: 'not-json' })).toEqual([]);
    expect(normalizeAskUserQuestions({ questions: null })).toEqual([]);
    expect(normalizeAskUserQuestions({ questions: [{ options: [], question: 42 }] })).toEqual([]);
  });

  it('parses stringified args or questions from double-encoded payloads', () => {
    const expected = [
      {
        header: 'Mode',
        options: [{ label: 'Auto' }],
        question: 'Which mode?',
      },
    ];

    expect(
      normalizeAskUserQuestions(
        JSON.stringify({
          questions: expected,
        }),
      ),
    ).toEqual(expected);
    expect(normalizeAskUserQuestions({ questions: JSON.stringify(expected) })).toEqual(expected);
  });

  it('repairs stringified questions with trailing garbage from model payloads', () => {
    // Seen in production: the model double-encodes `questions` and appends an
    // extra `}` after the array, so plain JSON.parse rejects the whole string.
    const questions = [
      {
        header: 'humanizer 调用方式',
        options: [
          {
            description: '每次模拟回复都显示草稿、诊断要点、终稿三部分',
            label: '每轮强制三段流程',
          },
          { description: '内部自查语言，只输出最终叙事', label: '仅按需触发，不显示过程' },
          { description: '明显有AI味时才精修且展示过程', label: '仅按需触发，显示过程' },
        ],
        question: '你希望之后每一轮模拟正文都强制走完整流程吗？',
      },
    ];

    expect(normalizeAskUserQuestions({ questions: `${JSON.stringify(questions)}}` })).toEqual(
      questions,
    );
  });

  it('strips the "(Recommended)" label marker into the recommended flag', () => {
    const questions = normalizeAskUserQuestions({
      questions: [
        {
          header: 'Scope',
          options: [
            { label: 'Narrow (Recommended)' },
            { label: 'Full（推荐）' },
            { label: 'recommended (recommended)' },
            { label: 'Plain' },
          ],
          question: 'How broad?',
        },
      ],
    });

    expect(questions[0].options).toEqual([
      { label: 'Narrow', recommended: true },
      { label: 'Full', recommended: true },
      { label: 'recommended', recommended: true },
      { label: 'Plain' },
    ]);
  });

  it('keeps a label that IS the marker instead of collapsing it to empty', () => {
    const questions = normalizeAskUserQuestions({
      questions: [{ options: [{ label: '(Recommended)' }], question: 'Pick' }],
    });

    expect(questions[0].options).toEqual([{ label: '(Recommended)' }]);
  });

  it('normalizes malformed options so renderers can map safely', () => {
    const questions = normalizeAskUserQuestions({
      questions: [
        {
          header: 123,
          multiSelect: 'yes',
          options: [{ label: 'Keep' }, { description: 'missing label' }, null],
          question: 'Pick one',
        },
      ],
    });

    expect(questions).toEqual([
      {
        header: '',
        options: [{ label: 'Keep' }],
        question: 'Pick one',
      },
    ]);
  });
});
