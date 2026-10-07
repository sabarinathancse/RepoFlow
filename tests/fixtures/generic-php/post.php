<?php
require_once 'includes/db.php';
include 'includes/header.php';
$id = $_GET['id'];
$post = mysqli_query($conn, "SELECT * FROM posts WHERE id = $id");
?>
<form method="post" action="comment.php">
  <input type="hidden" name="post_id" value="<?= (int) $id ?>"><textarea name="body"></textarea><button>Comment</button>
</form>
<?php include 'includes/footer.php'; ?>
