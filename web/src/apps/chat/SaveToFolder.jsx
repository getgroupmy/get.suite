// Chat's "Save to a folder…": choose where a file from a message goes (walk down, find a folder by name, a recent
// one, or a shared drive you can add to), then save it there.
import { useNavigate } from 'react-router';
import { useToast } from '../../components/ui.jsx';
import MoveDialog from '../../components/MoveDialog.jsx';
import { saveToDrive } from './savefile.js';

export default function SaveToFolder({ messageId, file, onClose }) {
  const toast = useToast();
  const navigate = useNavigate();
  return <MoveDialog files={[]} onClose={onClose}
    pick={{ title: `Save “${file.name}” to Drive`, action: 'Save here', onPick: (folderId) => saveToDrive(toast, navigate, messageId, file, folderId || null) }} />;
}
