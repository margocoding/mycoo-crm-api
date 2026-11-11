const labels: Record<string, string> = {
  new: 'Заявка на выплату принята', approved: 'Заявка на выплату одобрена',
  rejected: 'Заявка на выплату отклонена', paid: 'Вознаграждение выплачено',
};
export function payoutNotification(status: string, id: string, amountKopecks: number, reason = '') {
  const title = labels[status];
  if (!title) return null;
  const amount = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' }).format(amountKopecks / 100);
  const number = id.slice(-10).toUpperCase();
  const details = status === 'rejected' ? ` Причина: ${reason}` : status === 'new' ? ' Сумма зарезервирована до решения по выплате.' : '';
  return { title, message: `${title}. Заявка № ${number}, сумма ${amount}.${details}` };
}

export function pageAfter(cursor: { createdAt: Date; id: string } | null) {
  return cursor ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] } : {};
}
