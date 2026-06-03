import { Route, Routes } from 'react-router-dom'
import CapturePage from '@/pages/CapturePage'

export function AppRouter() {
  return (
    <Routes>
      <Route path="/" element={<CapturePage />} />
    </Routes>
  )
}
