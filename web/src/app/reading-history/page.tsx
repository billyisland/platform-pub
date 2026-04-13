import { redirect } from 'next/navigation'

export default function ReadingHistoryRedirect() {
  redirect('/library?tab=history')
}
