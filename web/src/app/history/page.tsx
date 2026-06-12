import { redirect } from 'next/navigation'

export default function HistoryRedirect() {
  redirect('/workspace?overlay=library&tab=history')
}
