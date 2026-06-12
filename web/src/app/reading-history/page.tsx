import { redirect } from 'next/navigation'

export default function ReadingHistoryRedirect() {
  redirect('/workspace?overlay=library&tab=history')
}
