import { Route, Routes } from 'react-router-dom'
import CapturePage from '@/pages/CapturePage'
import QueuePage from '@/pages/QueuePage'

export function AppRouter() {
  return (
    <Routes>
      <Route path="/" element={<CapturePage />} />
      <Route path="/queue" element={<QueuePage />} />
    </Routes>
  )
}
