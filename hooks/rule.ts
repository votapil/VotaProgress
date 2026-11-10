// What the mod tells the model: the standing rule and the two reminders.

import { compact } from './plan'
import type { Plan } from './plan'

/** The system prompt section. Frozen for a thread: check an edit in a new chat. */
export const RULE = [
  '# План задачи (progress)',
  '',
  'Пользователь следит за ходом работы по плану, который ты ведёшь инструментом progress.',
  '',
  '- Заводи план (action: "start"), если в задаче три и более различимых шага или она займёт больше одного хода. На вопрос, поиск, объяснение и правку в одном месте план не заводи.',
  '- Критерий конца (finish) называй явно, когда он понятен, например «залито и протестировано». Если финал открыт, finish не передавай.',
  '- Закрыл шаг - один вызов update, в том же сообщении, что и инструменты следующего шага.',
  '- План изменился - перестраивай его через update (add, drop), а не новым start.',
  '- Последний вызов progress делай до итогового ответа.',
  '- Если ход заканчивается вопросом к пользователю, шаг оставь активным и план не закрывай.',
  '- Цель и шаги пиши на языке пользователя.',
  '- Если ты субагент, план не ведёшь.',
].join('\n')

export const NUDGE =
  'Если это задача из нескольких шагов, заведи план через progress (action: "start").'

export const replanText = (plan: Plan): string =>
  `Контекст был сжат. Текущий план: «${plan.goal}». ${compact(plan)}`
