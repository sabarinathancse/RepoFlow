<?php
session_start();
require_once '../includes/db.php';
if (empty($_SESSION['admin'])) { header('Location: ../login.php'); exit; }
mysqli_query($conn, "DELETE FROM comments WHERE spam = 1");
echo json_encode(['ok' => true]);
