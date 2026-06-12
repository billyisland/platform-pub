import { redirect } from 'next/navigation'

export default function BookmarksRedirect() {
  redirect('/workspace?overlay=library')
}
