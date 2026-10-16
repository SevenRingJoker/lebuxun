/** ② 节点库：按 SPEC §12.1 分组静态占位（输入/上下文/生成/审阅/控制/章节/成长钩子/风格） */

const GROUPS: { title: string; items: string[] }[] = [
  { title: '输入', items: ['input.context', 'input.manual'] },
  { title: '上下文', items: ['context.memory', 'context.style'] },
  {
    title: '生成',
    items: ['generate.chapter-plan', 'generate.paragraph-multi', 'generate.dialogue', 'generate.polish'],
  },
  { title: '审阅', items: ['review.candidate-picker', 'review.chapter-end'] },
  { title: '控制', items: [] },
  { title: '章节', items: ['chapter.accumulator', 'chapter.finalizer', 'chapter.next-starter'] },
  {
    title: '成长钩子',
    items: ['growth.capture-diff', 'growth.update-profile', 'growth.calibrate-evaluator', 'memory.updater'],
  },
  { title: '风格', items: ['context.style', 'style.rag-retrieve', 'style.discriminator'] },
];

export default function NodeLibrary() {
  return (
    <aside className="app-nodelib">
      {GROUPS.map((group) => (
        <section key={group.title}>
          <h3>{group.title}</h3>
          {group.items.map((item) => (
            <div key={item} className="node-item" draggable>
              {item}
            </div>
          ))}
        </section>
      ))}
    </aside>
  );
}
